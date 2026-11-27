//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"errors"
	"net/http"
	"net/url"
	"regexp"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/internal/jlog"
)

// DropFilenameHeader carries the dropped file's name, percent-encoded
// (encodeURIComponent), since a header value cannot hold arbitrary Unicode.
const DropFilenameHeader = "X-Juggler-Filename"

// maxDropBytes caps one dropped file. The body is streamed to disk, never held
// in memory, so this bounds disk use per drop rather than server memory. A var
// so tests can lower it.
var maxDropBytes int64 = 2 << 30 // 2 GiB

// dropRoutePath matches the drop upload route's path, for the server's body
// limit, which exempts it (IsDropUploadPath).
var dropRoutePath = regexp.MustCompile(`^/api/session/conversations/[^/]+/drops$`)

// IsDropUploadPath reports whether p is the drop upload route's path. The
// server's blanket request-body cap skips that route, whose handler streams to
// disk under its own, larger cap.
func IsDropUploadPath(p string) bool { return dropRoutePath.MatchString(p) }

// HandleUploadDrop stores a dropped file's raw bytes (the request body, any
// Content-Type; name in DropFilenameHeader) in the project's drops folder
// (core.StoreDrop) and returns its core.DropRef. A body past maxDropBytes is
// refused with a 413, before a byte is read when its length is declared.
func (api *SessionAPI) HandleUploadDrop(w http.ResponseWriter, r *http.Request) {
	convID, ok := ConvIDFromVars(w, r)
	if !ok {
		return
	}
	if _, ok := api.convDirOf(convID); !ok {
		WriteMessageError(w, r, http.StatusNotFound, msg.New("Conversation not found"))
		return
	}
	project := ""
	if mgr := api.manager(); mgr != nil {
		project = mgr.GetProjectPath()
	}
	if project == "" {
		WriteMessageError(w, r, http.StatusConflict, msg.New("No project is open"))
		return
	}
	tooLarge := func() {
		WriteMessageError(w, r, http.StatusRequestEntityTooLarge,
			msg.New("The file is too large to drop (max {max} MB)", "max", maxDropBytes>>20))
	}
	if r.ContentLength > maxDropBytes {
		tooLarge()
		return
	}

	name := dropFilename(r.Header.Get(DropFilenameHeader))
	ref, err := core.StoreDrop(project, name, http.MaxBytesReader(w, r.Body, maxDropBytes))
	var overCap *http.MaxBytesError
	switch {
	case err == nil:
		WriteJSON(w, r, http.StatusOK, ref)
	case errors.As(err, &overCap):
		tooLarge()
	case errors.Is(err, core.ErrEmptyDrop):
		WriteMessageError(w, r, http.StatusBadRequest, msg.New("Empty upload"))
	default:
		jlog.Info("[drops] conv=%s upload of %q failed: %v", convID, name, err)
		WriteMessageError(w, r, http.StatusBadRequest, msg.New("Upload failed: {detail}", "detail", err.Error()))
	}
}

// dropFilename decodes the percent-encoded name the client sends, or keeps the
// header as it is when it is not valid percent-encoding.
func dropFilename(header string) string {
	if decoded, err := url.PathUnescape(header); err == nil {
		return decoded
	}
	return header
}
