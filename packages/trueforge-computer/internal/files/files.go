// Package files serves the chunked upload and download halves of the protocol. Every chunk is
// bounded and the whole file is verified, because an oversized frame closes the socket for
// every other request on the computer, not just this one.
package files

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"trueforge.dev/computer/internal/protocol"
)

// ErrBadRequest covers a chunk the client refuses to act on at all.
var ErrBadRequest = errors.New("bad file request")

// ErrIsDirectory is its own error so the server can map it to the right sandbox failure.
var ErrIsDirectory = errors.New("path is a directory")

const (
	// defaultWindow is how many chunks of one transfer may be in flight at once. The relay is
	// expected to pipeline a small window, and each chunk arrives on its own goroutine, so
	// arrival order says nothing about sequence order.
	defaultWindow = 32
	// defaultWaitTimeout bounds how long a chunk waits for its predecessor before the whole
	// transfer is given up, so a server that never sends chunk zero cannot pin a goroutine.
	defaultWaitTimeout = 60 * time.Second
)

type transfer struct {
	cond    *sync.Cond
	handle  *os.File
	path    string
	nextSeq int
	waiting int
	// closed is set when the transfer finished or was abandoned; waiters wake and fail.
	closed bool
}

type Options struct {
	// Window caps the chunks of one transfer that may wait for their turn.
	Window int
	// WaitTimeout bounds one chunk's wait for its predecessor.
	WaitTimeout time.Duration
}

// Transfers tracks the uploads that are still in progress, keyed by transfer id.
type Transfers struct {
	options Options

	mu   sync.Mutex
	open map[string]*transfer
}

func NewTransfers(options Options) *Transfers {
	if options.Window <= 0 {
		options.Window = defaultWindow
	}
	if options.WaitTimeout <= 0 {
		options.WaitTimeout = defaultWaitTimeout
	}
	return &Transfers{options: options, open: map[string]*transfer{}}
}

// Abandon closes and discards every open upload, waking anything waiting on them. A dropped
// socket makes the server restart the transfer from chunk zero, so a half-written file left
// behind is only a leak — and a misleading one, since it is not the file that was sent.
func (t *Transfers) Abandon() {
	t.mu.Lock()
	open := t.open
	t.open = map[string]*transfer{}
	t.mu.Unlock()
	for _, entry := range open {
		entry.cond.L.Lock()
		entry.closed = true
		handle := entry.handle
		entry.handle = nil
		path := entry.path
		entry.cond.Broadcast()
		entry.cond.L.Unlock()

		if handle != nil {
			_ = handle.Close()
		}
		if path != "" {
			_ = os.Remove(path)
		}
	}
}

// Open reports how many uploads are in progress, for status output.
func (t *Transfers) Open() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.open)
}

// Put appends one chunk at resolvedPath, which the policy has already checked. Chunks may
// arrive out of order because the relay pipelines them and each is handled on its own
// goroutine, so a chunk ahead of its turn waits rather than failing the transfer.
func (t *Transfers) Put(request protocol.FilePutRequest, resolvedPath string) (protocol.FilePutResult, error) {
	if request.TransferID == "" {
		return protocol.FilePutResult{}, fmt.Errorf("%w: no transfer id", ErrBadRequest)
	}
	if request.Seq < 0 {
		return protocol.FilePutResult{}, fmt.Errorf("%w: negative chunk sequence", ErrBadRequest)
	}
	data, err := base64.StdEncoding.DecodeString(request.DataB64)
	if err != nil {
		return protocol.FilePutResult{}, fmt.Errorf("%w: decode chunk %d: %s", ErrBadRequest, request.Seq, err)
	}
	if len(data) > protocol.ChunkBytes {
		return protocol.FilePutResult{}, fmt.Errorf("%w: chunk %d is %d bytes, over the %d limit",
			ErrBadRequest, request.Seq, len(data), protocol.ChunkBytes)
	}

	entry, err := t.entryFor(request)
	if err != nil {
		return protocol.FilePutResult{}, err
	}

	written, err := t.writeInOrder(entry, request, resolvedPath, data)
	if err != nil {
		t.discard(request.TransferID)
		return protocol.FilePutResult{}, err
	}
	if !request.Final {
		return protocol.FilePutResult{BytesWritten: written}, nil
	}
	return t.finish(request, resolvedPath, entry)
}

// entryFor finds or creates the transfer. A brand new transfer may be opened by any chunk
// inside the window, because the first frame off the wire is not necessarily chunk zero.
func (t *Transfers) entryFor(request protocol.FilePutRequest) (*transfer, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if entry, open := t.open[request.TransferID]; open {
		return entry, nil
	}
	if request.Seq >= t.options.Window {
		return nil, fmt.Errorf("%w: transfer %s opens at chunk %d, beyond the %d chunk window",
			ErrBadRequest, request.TransferID, request.Seq, t.options.Window)
	}
	entry := &transfer{cond: sync.NewCond(&sync.Mutex{})}
	t.open[request.TransferID] = entry
	return entry, nil
}

// writeInOrder waits for this chunk's turn, then appends it. A chunk the transfer has already
// taken is answered without rewriting, which is what makes a redelivered frame harmless.
func (t *Transfers) writeInOrder(entry *transfer, request protocol.FilePutRequest, resolvedPath string, data []byte) (int64, error) {
	entry.cond.L.Lock()
	defer entry.cond.L.Unlock()

	if entry.closed {
		return 0, fmt.Errorf("%w: transfer %s is no longer open", ErrBadRequest, request.TransferID)
	}
	if request.Seq < entry.nextSeq {
		// Already written. Answering with the byte count keeps a redelivery idempotent.
		return int64(len(data)), nil
	}
	if entry.waiting >= t.options.Window {
		return 0, fmt.Errorf("%w: %d chunks of transfer %s are already waiting",
			ErrBadRequest, entry.waiting, request.TransferID)
	}

	if request.Seq > entry.nextSeq {
		entry.waiting++
		timer := time.AfterFunc(t.options.WaitTimeout, func() {
			entry.cond.L.Lock()
			defer entry.cond.L.Unlock()
			entry.cond.Broadcast()
		})
		deadline := time.Now().Add(t.options.WaitTimeout)
		for request.Seq > entry.nextSeq && !entry.closed && time.Now().Before(deadline) {
			entry.cond.Wait()
		}
		entry.waiting--
		timer.Stop()
	}

	if entry.closed {
		return 0, fmt.Errorf("%w: transfer %s was abandoned while chunk %d waited",
			ErrBadRequest, request.TransferID, request.Seq)
	}
	if request.Seq < entry.nextSeq {
		return int64(len(data)), nil
	}
	if request.Seq > entry.nextSeq {
		return 0, fmt.Errorf("%w: chunk %d of transfer %s waited for chunk %d and it never arrived",
			ErrBadRequest, request.Seq, request.TransferID, entry.nextSeq)
	}

	if entry.handle == nil {
		if err := os.MkdirAll(filepath.Dir(resolvedPath), 0o755); err != nil {
			return 0, fmt.Errorf("create the directory for %s: %w", resolvedPath, err)
		}
		handle, err := os.OpenFile(resolvedPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return 0, fmt.Errorf("open %s: %w", resolvedPath, err)
		}
		entry.handle = handle
		entry.path = resolvedPath
	}
	if _, err := entry.handle.Write(data); err != nil {
		return 0, fmt.Errorf("write %s: %w", resolvedPath, err)
	}
	entry.nextSeq++
	entry.cond.Broadcast()
	return int64(len(data)), nil
}

// finish closes the file and checks the digest the server computed before it sent anything.
func (t *Transfers) finish(request protocol.FilePutRequest, resolvedPath string, entry *transfer) (protocol.FilePutResult, error) {
	t.mu.Lock()
	delete(t.open, request.TransferID)
	t.mu.Unlock()

	entry.cond.L.Lock()
	entry.closed = true
	handle := entry.handle
	entry.handle = nil
	entry.cond.Broadcast()
	entry.cond.L.Unlock()

	if handle != nil {
		if err := handle.Close(); err != nil {
			return protocol.FilePutResult{}, fmt.Errorf("close %s: %w", resolvedPath, err)
		}
	}
	digest, size, err := Digest(resolvedPath)
	if err != nil {
		return protocol.FilePutResult{}, err
	}
	if request.SHA256 != nil && *request.SHA256 != digest {
		// A file that does not match what the server sent is worse than no file: remove it
		// rather than leave a corrupt upload for a command to read.
		_ = os.Remove(resolvedPath)
		return protocol.FilePutResult{}, fmt.Errorf("%w: digest mismatch for %s: expected %s, wrote %s",
			ErrBadRequest, resolvedPath, *request.SHA256, digest)
	}
	return protocol.FilePutResult{BytesWritten: size, SHA256: &digest}, nil
}

func (t *Transfers) discard(transferID string) {
	t.mu.Lock()
	entry, open := t.open[transferID]
	delete(t.open, transferID)
	t.mu.Unlock()
	if !open {
		return
	}
	entry.cond.L.Lock()
	entry.closed = true
	handle := entry.handle
	entry.handle = nil
	path := entry.path
	entry.cond.Broadcast()
	entry.cond.L.Unlock()

	if handle != nil {
		_ = handle.Close()
	}
	if path != "" {
		_ = os.Remove(path)
	}
}

// Get reads one window of a file. The window is clamped to the chunk size whatever the
// request asks for, so no reply can grow into a frame that would close the socket.
func Get(request protocol.FileGetRequest, resolvedPath string) (protocol.FileGetResult, error) {
	if request.Offset < 0 {
		return protocol.FileGetResult{}, fmt.Errorf("%w: negative offset", ErrBadRequest)
	}
	info, err := os.Stat(resolvedPath)
	if err != nil {
		return protocol.FileGetResult{}, fmt.Errorf("stat %s: %w", resolvedPath, err)
	}
	if info.IsDir() {
		return protocol.FileGetResult{}, fmt.Errorf("%w: %s", ErrIsDirectory, resolvedPath)
	}

	maxBytes := request.MaxBytes
	if maxBytes <= 0 || maxBytes > protocol.ChunkBytes {
		maxBytes = protocol.ChunkBytes
	}
	handle, err := os.Open(resolvedPath)
	if err != nil {
		return protocol.FileGetResult{}, fmt.Errorf("open %s: %w", resolvedPath, err)
	}
	defer func() { _ = handle.Close() }()

	buffer := make([]byte, maxBytes)
	read, err := handle.ReadAt(buffer, request.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return protocol.FileGetResult{}, fmt.Errorf("read %s: %w", resolvedPath, err)
	}
	result := protocol.FileGetResult{
		DataB64: base64.StdEncoding.EncodeToString(buffer[:read]),
		EOF:     request.Offset+int64(read) >= info.Size(),
		Size:    info.Size(),
	}
	// The whole-file digest rides on the first window so the caller can verify the download
	// without asking for a second pass over the file.
	if request.Offset == 0 {
		digest, _, digestErr := Digest(resolvedPath)
		if digestErr != nil {
			return protocol.FileGetResult{}, digestErr
		}
		result.SHA256 = &digest
	}
	return result, nil
}

// Digest returns the hex sha256 of a file and its size.
func Digest(path string) (string, int64, error) {
	handle, err := os.Open(path)
	if err != nil {
		return "", 0, fmt.Errorf("open %s for hashing: %w", path, err)
	}
	defer func() { _ = handle.Close() }()
	hasher := sha256.New()
	size, err := io.Copy(hasher, handle)
	if err != nil {
		return "", 0, fmt.Errorf("hash %s: %w", path, err)
	}
	return hex.EncodeToString(hasher.Sum(nil)), size, nil
}
