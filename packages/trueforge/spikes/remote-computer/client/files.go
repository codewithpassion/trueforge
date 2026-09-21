package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// transfers holds the files an upload is still appending to, keyed by transfer id.
type transfers struct {
	mu   sync.Mutex
	open map[string]*os.File
}

func newTransfers() *transfers {
	return &transfers{open: map[string]*os.File{}}
}

// put appends one chunk. The final chunk verifies the whole-file digest the server computed.
func (t *transfers) put(request filePutRequest) (filePutResult, error) {
	data, err := base64.StdEncoding.DecodeString(request.DataB64)
	if err != nil {
		return filePutResult{}, fmt.Errorf("decode chunk %d: %w", request.Seq, err)
	}

	t.mu.Lock()
	handle, open := t.open[request.TransferID]
	if !open {
		if err := os.MkdirAll(filepath.Dir(request.Path), 0o755); err != nil {
			t.mu.Unlock()
			return filePutResult{}, fmt.Errorf("create directory for %s: %w", request.Path, err)
		}
		handle, err = os.OpenFile(request.Path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			t.mu.Unlock()
			return filePutResult{}, fmt.Errorf("open %s: %w", request.Path, err)
		}
		t.open[request.TransferID] = handle
	}
	t.mu.Unlock()

	if _, err := handle.Write(data); err != nil {
		return filePutResult{}, fmt.Errorf("write %s: %w", request.Path, err)
	}
	if !request.Final {
		return filePutResult{BytesWritten: int64(len(data))}, nil
	}

	t.mu.Lock()
	delete(t.open, request.TransferID)
	t.mu.Unlock()
	if err := handle.Close(); err != nil {
		return filePutResult{}, fmt.Errorf("close %s: %w", request.Path, err)
	}
	digest, size, err := digestFile(request.Path)
	if err != nil {
		return filePutResult{}, err
	}
	if request.SHA256 != nil && *request.SHA256 != digest {
		return filePutResult{}, fmt.Errorf("digest mismatch for %s: expected %s, wrote %s", request.Path, *request.SHA256, digest)
	}
	return filePutResult{BytesWritten: size, SHA256: &digest}, nil
}

// get reads one window of a file. The first window also carries the whole-file digest, so the caller
// can verify the download without a second pass.
func get(request fileGetRequest) (fileGetResult, error) {
	info, err := os.Stat(request.Path)
	if err != nil {
		return fileGetResult{}, fmt.Errorf("stat %s: %w", request.Path, err)
	}
	if info.IsDir() {
		return fileGetResult{}, fmt.Errorf("%s is a directory", request.Path)
	}
	handle, err := os.Open(request.Path)
	if err != nil {
		return fileGetResult{}, fmt.Errorf("open %s: %w", request.Path, err)
	}
	defer func() { _ = handle.Close() }()

	maxBytes := request.MaxBytes
	if maxBytes <= 0 {
		maxBytes = 256 * 1024
	}
	buffer := make([]byte, maxBytes)
	read, err := handle.ReadAt(buffer, request.Offset)
	if err != nil && err != io.EOF {
		return fileGetResult{}, fmt.Errorf("read %s: %w", request.Path, err)
	}
	result := fileGetResult{
		DataB64: base64.StdEncoding.EncodeToString(buffer[:read]),
		EOF:     request.Offset+int64(read) >= info.Size(),
		Size:    info.Size(),
	}
	if request.Offset == 0 {
		digest, _, digestErr := digestFile(request.Path)
		if digestErr != nil {
			return fileGetResult{}, digestErr
		}
		result.SHA256 = &digest
	}
	return result, nil
}

func digestFile(path string) (string, int64, error) {
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
