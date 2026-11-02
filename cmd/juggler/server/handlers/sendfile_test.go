//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// deniedSendfileWriter stands in for net/http's response: ReadFrom copies
// sniff bytes the ordinary way, then fails with EPERM as a sandboxed sendfile
// does. A zero sniff is the denial arriving before any byte moved.
type deniedSendfileWriter struct {
	*httptest.ResponseRecorder
	sniff int64
}

func (w *deniedSendfileWriter) ReadFrom(r io.Reader) (int64, error) {
	n, err := io.Copy(w.ResponseRecorder, io.LimitReader(r, w.sniff))
	if err != nil {
		return n, err
	}
	return n, &os.SyscallError{Syscall: "sendfile", Err: fs.ErrPermission}
}

// TestSendfileFallbackHandler: a file server behind the handler (user
// extensions, dev-mode static files) serves whole files when sendfile is
// denied, and passes through a ReadFrom error that is not a denial.
func TestSendfileFallbackHandler(t *testing.T) {
	dir := t.TempDir()
	body := bytes.Repeat([]byte("export const line = 'héllo';\n"), 4096)
	if err := os.WriteFile(filepath.Join(dir, "ext.js"), body, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	h := SendfileFallbackHandler(http.FileServer(http.Dir(dir)))

	for _, sniff := range []int64{0, 512} {
		t.Run(fmt.Sprintf("sniff=%d", sniff), func(t *testing.T) {
			w := &deniedSendfileWriter{ResponseRecorder: httptest.NewRecorder(), sniff: sniff}
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ext.js", nil))
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", w.Code)
			}
			if !bytes.Equal(w.Body.Bytes(), body) {
				t.Errorf("body differs: got %d bytes, want %d", w.Body.Len(), len(body))
			}
		})
	}

	t.Run("other errors pass through", func(t *testing.T) {
		broken := errors.New("connection reset")
		w := SendfileFallback(&failingReadFromWriter{httptest.NewRecorder(), broken})
		_, err := w.(io.ReaderFrom).ReadFrom(bytes.NewReader(body))
		if !errors.Is(err, broken) {
			t.Fatalf("ReadFrom error = %v, want %v", err, broken)
		}
	})
}

// failingReadFromWriter fails every ReadFrom with err before moving a byte.
type failingReadFromWriter struct {
	*httptest.ResponseRecorder
	err error
}

func (w *failingReadFromWriter) ReadFrom(io.Reader) (int64, error) { return 0, w.err }
