//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"juggler/cmd/juggler/ops"
)

// MaxFileContentBytes caps what the content route will stream. A file viewer
// renders incrementally (PDF.js fetches page ranges), so this is a ceiling on a
// single response, not on what a viewer can display.
const MaxFileContentBytes = 100 << 20

// FilesAPI serves file bytes for rendering. The project path is looked up via a
// provider func so runtime project switches retarget it, matching OpsAPI.
type FilesAPI struct {
	pathProvider func() string
}

// NewFilesAPI creates the file-content handler. pathProvider must return the
// current project path on each call.
func NewFilesAPI(pathProvider func() string) *FilesAPI {
	return &FilesAPI{pathProvider: pathProvider}
}

// HandleGetFileContent streams a file's raw bytes so a file viewer can render it
// without the content round-tripping through a tool result (which, for an image,
// meant a 33% base64 inflation through the conversation document).
//
// SECURITY. This is a token-authenticated GET whose token may ride in the query
// string (a <canvas>/<img>/<iframe> load cannot set a header), so it is treated
// as the most exposed read surface in the API and is deliberately narrower than
// the read op:
//
//   - The path is resolved through the SAME helper the read op uses
//     (ops.PathScope), never a bare filepath.Join, so traversal and symlink
//     escapes are rejected by the shared, tested implementation.
//   - Containment is to the project root ONLY. The read op's escape hatches
//     (userInitiated, outOfRootApproved) are NOT honoured here: they would have
//     to arrive as query parameters, where anything holding the token could
//     forge them and turn this into an arbitrary-file read. A viewer that needs
//     an out-of-project file uses the conversation asset store instead, which is
//     content-addressed and already scoped to what the user approved.
//   - Directories are refused, and the response is served with an explicit
//     Content-Type plus nosniff so the browser cannot be talked into treating a
//     file as script.
func (api *FilesAPI) HandleGetFileContent(w http.ResponseWriter, r *http.Request) {
	api.serveProjectFile(w, r, r.URL.Query().Get("path"))
}

// FileTreePrefix is the route under which HandleGetFileTree serves files by
// path. What follows it is `<token>/<absolute path>`.
const FileTreePrefix = "/api/session/files/tree/"

// HandleGetFileTree serves the same files as HandleGetFileContent, addressed by
// URL path instead of query: GET <FileTreePrefix><token>/<absolute path>, the
// path's leading slash dropped. A page framed from here sits in its own
// directory as far as the browser can tell, so the images, styles and scripts
// it links relatively resolve to the files beside it — and to this route, with
// the token still in the path. A `../` above the project root is refused by the
// same containment as the query route; one above the filesystem root eats the
// token segment and is refused by the auth middleware.
//
// The token segment is read by apiAuthMiddleware (see fileTreeToken), not here.
func (api *FilesAPI) HandleGetFileTree(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, FileTreePrefix)
	_, filePath, ok := strings.Cut(rest, "/")
	if !ok || filePath == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}
	// A Windows path keeps its drive letter as the first segment; anything else
	// had its leading slash dropped when it was made into a URL path.
	if !isDriveLetterPath(filePath) {
		filePath = "/" + filePath
	}
	api.serveProjectFile(w, r, filepath.FromSlash(filePath))
}

// isDriveLetterPath reports whether p begins with a Windows drive letter, as in
// "C:/Users".
func isDriveLetterPath(p string) bool {
	if len(p) < 2 || p[1] != ':' {
		return false
	}
	c := p[0]
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// serveProjectFile streams the file at requested, contained to the project
// root. Both GET routes share it, and with it the SECURITY rules on
// HandleGetFileContent.
func (api *FilesAPI) serveProjectFile(w http.ResponseWriter, r *http.Request, requested string) {
	if requested == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}

	projectPath := api.pathProvider()
	if projectPath == "" {
		http.Error(w, "no project loaded", http.StatusConflict)
		return
	}

	// Resolve (not ResolveRead): containment to the project root is the policy
	// boundary for this route — see the SECURITY note above.
	scope := ops.NewPathScope(projectPath, nil)
	result, err := scope.Resolve(requested)
	if err != nil || result == nil || !result.IsValid {
		http.Error(w, "path is outside the project", http.StatusForbidden)
		return
	}
	absPath := result.AbsPath

	info, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		http.Error(w, "Couldn't inspect file", http.StatusInternalServerError)
		return
	}
	if info.IsDir() {
		http.Error(w, "path is a directory", http.StatusBadRequest)
		return
	}
	if info.Size() > MaxFileContentBytes {
		http.Error(w, "file is too large to stream", http.StatusRequestEntityTooLarge)
		return
	}

	file, err := os.Open(absPath)
	if err != nil {
		http.Error(w, "Couldn't open file", http.StatusInternalServerError)
		return
	}
	defer func() { _ = file.Close() }()

	contentType := ops.MimeForPath(absPath)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// The file is live on disk and can change under a pin, so it must never be
	// cached the way an immutable content-addressed asset is. ServeContent still
	// answers conditional requests from the modtime below.
	w.Header().Set("Cache-Control", "no-cache, must-revalidate")

	// ServeContent supplies Accept-Ranges and range handling, so a viewer can
	// fetch incrementally instead of buffering the whole file.
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

// FileBytesRequest is the body of a raw-bytes read. It mirrors the read op's
// path vocabulary (see ops.PathScope.ResolveRead) because it resolves through
// exactly the same call.
type FileBytesRequest struct {
	Path              string   `json:"path"`
	UserInitiated     bool     `json:"userInitiated,omitempty"`
	OutOfRootApproved bool     `json:"outOfRootApproved,omitempty"`
	AllowedPaths      []string `json:"allowedPaths,omitempty"`
}

// HandlePostFileBytes returns a file's raw bytes to a viewer that the streaming
// GET route cannot serve: a file outside the project root, which that route
// refuses by design.
//
// SECURITY. The containment asymmetry with HandleGetFileContent is deliberate
// and rests entirely on how each route is authenticated:
//
//   - The GET route's token may ride in the query string, because a
//     <canvas>/<img>/<iframe> load cannot set a header. Anything that leaks such
//     a URL leaks a usable credential, so that route honours no escape hatch and
//     is contained to the project root, full stop.
//   - This route is POST and accepts the token ONLY as the X-Juggler-Token
//     header (apiAuthMiddleware consults ?token= for GET asset requests alone),
//     which additionally forces a CORS preflight that no cross-origin caller
//     survives. Its escape hatches therefore travel in the body, at the same
//     trust boundary /api/ops/call already grants the read op — a caller able to
//     forge them here can call readFile with the same flags anyway.
//
// So this adds no authority: it gives a file viewer the byte transport the read
// op already has, for the user-initiated (@-mention, file picker) and
// explicitly-approved out-of-root reads the viewer layer must be able to render.
func (api *FilesAPI) HandlePostFileBytes(w http.ResponseWriter, r *http.Request) {
	var req FileBytesRequest
	// The body is a small descriptor; cap it so a malformed request cannot be
	// used to buffer an arbitrary amount of memory.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Path == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}

	projectPath := api.pathProvider()
	if projectPath == "" {
		http.Error(w, "no project loaded", http.StatusConflict)
		return
	}

	// ResolveRead is the read op's own resolver, so the escape hatches, the
	// symlink handling, and the allowed-paths grant all behave identically here.
	scope := ops.NewPathScope(projectPath, req.AllowedPaths)
	absPath, err := scope.ResolveRead(req.Path, req.UserInitiated, req.OutOfRootApproved)
	if err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}

	info, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		http.Error(w, "Couldn't inspect file", http.StatusInternalServerError)
		return
	}
	if info.IsDir() {
		http.Error(w, "path is a directory", http.StatusBadRequest)
		return
	}
	if info.Size() > MaxFileContentBytes {
		http.Error(w, "file is too large to stream", http.StatusRequestEntityTooLarge)
		return
	}

	file, err := os.Open(absPath)
	if err != nil {
		http.Error(w, "Couldn't open file", http.StatusInternalServerError)
		return
	}
	defer func() { _ = file.Close() }()

	contentType := ops.MimeForPath(absPath)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	// A POST response is not cached by default; say so explicitly since the file
	// is live on disk and every read must see the current bytes.
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.Copy(w, file)
}
