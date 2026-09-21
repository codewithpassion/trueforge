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

	"trueforge.dev/computer/internal/protocol"
)

// ErrBadRequest covers a chunk the client refuses to act on at all.
var ErrBadRequest = errors.New("bad file request")

type transfer struct {
	handle  *os.File
	path    string
	nextSeq int
	written int64
}

// Transfers tracks the uploads that are still in progress, keyed by transfer id.
type Transfers struct {
	mu   sync.Mutex
	open map[string]*transfer
}

func NewTransfers() *Transfers {
	return &Transfers{open: map[string]*transfer{}}
}

// Abandon closes and discards every open upload. A dropped socket makes the server restart
// the transfer from chunk zero, so a half-written file left open is only a leak.
func (t *Transfers) Abandon() {
	t.mu.Lock()
	open := t.open
	t.open = map[string]*transfer{}
	t.mu.Unlock()
	for _, entry := range open {
		_ = entry.handle.Close()
		_ = os.Remove(entry.path)
	}
}

// Open reports how many uploads are in progress, for status output.
func (t *Transfers) Open() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.open)
}

// Put appends one chunk at resolvedPath, which the policy has already checked. The final
// chunk verifies the whole-file digest the server computed before sending.
func (t *Transfers) Put(request protocol.FilePutRequest, resolvedPath string) (protocol.FilePutResult, error) {
	if request.TransferID == "" {
		return protocol.FilePutResult{}, fmt.Errorf("%w: no transfer id", ErrBadRequest)
	}
	data, err := base64.StdEncoding.DecodeString(request.DataB64)
	if err != nil {
		return protocol.FilePutResult{}, fmt.Errorf("%w: decode chunk %d: %s", ErrBadRequest, request.Seq, err)
	}
	if len(data) > protocol.ChunkBytes {
		return protocol.FilePutResult{}, fmt.Errorf("%w: chunk %d is %d bytes, over the %d limit",
			ErrBadRequest, request.Seq, len(data), protocol.ChunkBytes)
	}

	entry, err := t.entryFor(request, resolvedPath)
	if err != nil {
		return protocol.FilePutResult{}, err
	}

	if request.Seq != entry.nextSeq {
		t.discard(request.TransferID)
		return protocol.FilePutResult{}, fmt.Errorf("%w: chunk %d arrived out of order, expected %d",
			ErrBadRequest, request.Seq, entry.nextSeq)
	}
	if _, err := entry.handle.Write(data); err != nil {
		t.discard(request.TransferID)
		return protocol.FilePutResult{}, fmt.Errorf("write %s: %w", resolvedPath, err)
	}
	entry.nextSeq++
	entry.written += int64(len(data))

	if !request.Final {
		return protocol.FilePutResult{BytesWritten: int64(len(data))}, nil
	}

	t.mu.Lock()
	delete(t.open, request.TransferID)
	t.mu.Unlock()
	if err := entry.handle.Close(); err != nil {
		return protocol.FilePutResult{}, fmt.Errorf("close %s: %w", resolvedPath, err)
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

func (t *Transfers) entryFor(request protocol.FilePutRequest, resolvedPath string) (*transfer, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if entry, open := t.open[request.TransferID]; open {
		return entry, nil
	}
	if request.Seq != 0 {
		return nil, fmt.Errorf("%w: transfer %s starts at chunk %d, not 0", ErrBadRequest, request.TransferID, request.Seq)
	}
	if err := os.MkdirAll(filepath.Dir(resolvedPath), 0o755); err != nil {
		return nil, fmt.Errorf("create the directory for %s: %w", resolvedPath, err)
	}
	handle, err := os.OpenFile(resolvedPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", resolvedPath, err)
	}
	entry := &transfer{handle: handle, path: resolvedPath}
	t.open[request.TransferID] = entry
	return entry, nil
}

func (t *Transfers) discard(transferID string) {
	t.mu.Lock()
	entry, open := t.open[transferID]
	delete(t.open, transferID)
	t.mu.Unlock()
	if open {
		_ = entry.handle.Close()
		_ = os.Remove(entry.path)
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
		return protocol.FileGetResult{}, fmt.Errorf("%s is a directory", resolvedPath)
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
