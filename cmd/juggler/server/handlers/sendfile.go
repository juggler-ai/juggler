//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
)

// SendfileFallback wraps w so that a file copied into it finishes by plain
// writes when the kernel denies sendfile. Every response that streams an
// *os.File needs it: net/http reaches sendfile through ReadFrom and returns a
// denial to the caller instead of retrying, which cuts the body off after the
// 512 bytes it sniffs first. macOS sandboxes that confine network traffic to a
// proxy (nono's allowlist mode) deny sendfile, although ordinary socket writes
// work.
func SendfileFallback(w http.ResponseWriter) http.ResponseWriter {
	return sendfileFallback{w}
}

// SendfileFallbackHandler applies SendfileFallback to every response h writes.
// It is for file servers. The wrapper hides every optional interface but
// ReaderFrom from a type assertion, so a handler that asserts http.Hijacker or
// http.Flusher directly, rather than going through http.ResponseController,
// must not sit behind it.
func SendfileFallbackHandler(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(SendfileFallback(w), r)
	})
}

type sendfileFallback struct{ http.ResponseWriter }

// Unwrap exposes the wrapped writer to http.ResponseController.
func (w sendfileFallback) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// ReadFrom copies src to the response, through sendfile when the server offers
// it. After a permission denial, src holds exactly the bytes not yet sent, so
// the rest goes through Write.
func (w sendfileFallback) ReadFrom(src io.Reader) (int64, error) {
	plain := struct{ io.Writer }{w.ResponseWriter}
	rf, ok := w.ResponseWriter.(io.ReaderFrom)
	if !ok {
		return io.Copy(plain, src)
	}
	n, err := rf.ReadFrom(src)
	if !errors.Is(err, fs.ErrPermission) {
		return n, err
	}
	m, err := io.Copy(plain, src)
	return n + m, err
}
