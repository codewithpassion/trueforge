package files_test

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"trueforge.dev/computer/internal/files"
	"trueforge.dev/computer/internal/protocol"
)

func chunkRequest(transferID string, path string, seq int, data []byte, final bool, digest *string) protocol.FilePutRequest {
	return protocol.FilePutRequest{
		TransferID: transferID,
		Path:       path,
		Seq:        seq,
		DataB64:    base64.StdEncoding.EncodeToString(data),
		Final:      final,
		SHA256:     digest,
	}
}

func hexDigest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// A whole file goes up in chunk-sized frames and comes back down the same way, and the
// digests agree at both ends.
func TestChunkedRoundTrip(t *testing.T) {
	payload := make([]byte, protocol.ChunkBytes*2+1234)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("make payload: %v", err)
	}
	digest := hexDigest(payload)
	target := filepath.Join(t.TempDir(), "nested", "payload.bin")

	transfers := files.NewTransfers()
	for seq, offset := 0, 0; offset < len(payload); seq, offset = seq+1, offset+protocol.ChunkBytes {
		end := min(offset+protocol.ChunkBytes, len(payload))
		final := end == len(payload)
		var expected *string
		if final {
			expected = &digest
		}
		result, err := transfers.Put(chunkRequest("x", target, seq, payload[offset:end], final, expected), target)
		if err != nil {
			t.Fatalf("put chunk %d: %v", seq, err)
		}
		if final {
			if result.SHA256 == nil || *result.SHA256 != digest {
				t.Fatalf("final chunk digest = %v", result.SHA256)
			}
			if result.BytesWritten != int64(len(payload)) {
				t.Fatalf("bytes_written = %d, want %d", result.BytesWritten, len(payload))
			}
		}
	}
	if transfers.Open() != 0 {
		t.Fatal("the transfer was not closed")
	}

	var downloaded bytes.Buffer
	var offset int64
	for {
		result, err := files.Get(protocol.FileGetRequest{Path: target, Offset: offset, MaxBytes: protocol.ChunkBytes}, target)
		if err != nil {
			t.Fatalf("get at %d: %v", offset, err)
		}
		if offset == 0 {
			if result.SHA256 == nil || *result.SHA256 != digest {
				t.Fatalf("the first window carried %v, want the whole-file digest", result.SHA256)
			}
		} else if result.SHA256 != nil {
			t.Fatal("only the first window carries the digest")
		}
		decoded, err := base64.StdEncoding.DecodeString(result.DataB64)
		if err != nil {
			t.Fatalf("decode window: %v", err)
		}
		downloaded.Write(decoded)
		offset += int64(len(decoded))
		if result.EOF {
			break
		}
	}
	if hexDigest(downloaded.Bytes()) != digest {
		t.Fatal("the downloaded bytes do not match what was uploaded")
	}
}

func TestDigestMismatchIsRejectedAndTheFileRemoved(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers()
	wrong := hexDigest([]byte("something else"))
	_, err := transfers.Put(chunkRequest("x", target, 0, []byte("payload"), true, &wrong), target)
	if !errors.Is(err, files.ErrBadRequest) {
		t.Fatalf("error = %v, want ErrBadRequest", err)
	}
	if _, statErr := os.Stat(target); statErr == nil {
		t.Fatal("a file that failed its digest was left on disk")
	}
}

func TestOversizedChunkIsRefused(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers()
	oversized := make([]byte, protocol.ChunkBytes+1)
	_, err := transfers.Put(chunkRequest("x", target, 0, oversized, false, nil), target)
	if !errors.Is(err, files.ErrBadRequest) {
		t.Fatalf("error = %v, want ErrBadRequest", err)
	}
}

func TestOutOfOrderChunkAbandonsTheTransfer(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers()
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("a"), false, nil), target); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	_, err := transfers.Put(chunkRequest("x", target, 2, []byte("c"), false, nil), target)
	if !errors.Is(err, files.ErrBadRequest) {
		t.Fatalf("error = %v, want ErrBadRequest", err)
	}
	if transfers.Open() != 0 {
		t.Fatal("the broken transfer is still open")
	}
	if _, statErr := os.Stat(target); statErr == nil {
		t.Fatal("the partial file was left on disk")
	}
}

func TestATransferMustStartAtChunkZero(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers()
	_, err := transfers.Put(chunkRequest("x", target, 3, []byte("a"), false, nil), target)
	if !errors.Is(err, files.ErrBadRequest) {
		t.Fatalf("error = %v, want ErrBadRequest", err)
	}
}

func TestAbandonClosesOpenTransfers(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers()
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("a"), false, nil), target); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	transfers.Abandon()
	if transfers.Open() != 0 {
		t.Fatal("Abandon left a transfer open")
	}
	if _, statErr := os.Stat(target); statErr == nil {
		t.Fatal("Abandon left the partial file on disk")
	}
}

// A request for a window larger than the chunk size must be clamped, not honoured: an
// oversized frame closes the socket for every other request on the computer.
func TestGetWindowIsClampedToTheChunkSize(t *testing.T) {
	target := filepath.Join(t.TempDir(), "big.bin")
	payload := make([]byte, protocol.ChunkBytes*2)
	if err := os.WriteFile(target, payload, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	result, err := files.Get(protocol.FileGetRequest{Path: target, Offset: 0, MaxBytes: 16 << 20}, target)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(result.DataB64)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(decoded) != protocol.ChunkBytes {
		t.Fatalf("window = %d bytes, want it clamped to %d", len(decoded), protocol.ChunkBytes)
	}
	if result.EOF {
		t.Fatal("a clamped first window of a two-chunk file is not the end")
	}
}

func TestGetRefusesADirectoryAndAMissingFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := files.Get(protocol.FileGetRequest{Path: dir}, dir); err == nil {
		t.Fatal("a directory was served as a file")
	}
	missing := filepath.Join(dir, "nope")
	if _, err := files.Get(protocol.FileGetRequest{Path: missing}, missing); err == nil {
		t.Fatal("a missing file was served")
	}
}

func TestUploadedFileIsOwnerOnly(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers()
	digest := hexDigest([]byte("x"))
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("x"), true, &digest), target); err != nil {
		t.Fatalf("put: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("uploaded file mode is %v", info.Mode().Perm())
	}
}
