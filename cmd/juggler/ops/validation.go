//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/unicode"

	"juggler/internal/jlog"
)

// Security limits
const (
	MaxFileSize      = 10 * 1024 * 1024 // 10MB max file size
	MaxTreeDepth     = 50               // Maximum directory tree depth
	MaxPatternLength = 1000             // Maximum regex pattern length
)

// PathValidationResult contains the result of path validation
type PathValidationResult struct {
	AbsPath  string
	RelPath  string
	IsValid  bool
	ErrorMsg string
}

// PathScope is the filesystem boundary a set of operation handlers resolve
// paths against. It bundles the project working directory (Root) with the
// user's standing allowed-paths grant (allowedRoots), so the boundary travels
// as one value from the HTTP layer into every handler instead of riding inside
// the per-call params map and being re-extracted at each callsite.
type PathScope struct {
	root         string
	allowedRoots []string
	// remap, when set, translates an already-validated real absolute path into
	// the path the op should actually touch — the conversation's dedicated git
	// worktree of whichever repository the path belongs to (see
	// core.ConvWorktrees). It is applied to the OUTPUT of Resolve/Sanitize, so
	// containment and out-of-scope-write authorization still run in real-project
	// space (the security boundary is unchanged) while execution is redirected
	// into the worktree. nil ⇒ identity (no per-conversation isolation).
	remap func(string) string
}

// NewPathScope builds a PathScope for a working directory widened by an
// optional set of allowed roots. allowedRoots is copied (nil-safe) so the
// scope is immutable and cannot be mutated by the caller after construction.
func NewPathScope(root string, allowedRoots []string) PathScope {
	var roots []string
	if len(allowedRoots) > 0 {
		roots = make([]string, len(allowedRoots))
		copy(roots, allowedRoots)
	}
	return PathScope{root: root, allowedRoots: roots}
}

// WithRemap returns a copy of the scope whose resolved paths are redirected into
// per-conversation git worktrees by fn (see the remap field). fn is applied to
// already-validated real paths; passing nil yields an identity scope.
func (s PathScope) WithRemap(fn func(string) string) PathScope {
	s.remap = fn
	return s
}

// applyRemap redirects a real absolute path into its worktree when a remap is
// set, else returns it unchanged.
func (s PathScope) applyRemap(abs string) string {
	if s.remap == nil {
		return abs
	}
	return s.remap(abs)
}

// Root returns the real project working directory this scope is anchored at.
// It is the security/validation anchor; for the directory an op should actually
// operate in (redirected into the conversation's worktree) use BaseDir.
func (s PathScope) Root() string {
	return s.root
}

// BaseDir is the working directory an op should default to when no explicit
// path is given (grep/tree search base, shell cwd) — the real root redirected
// into the conversation's worktree of the project's own repo, or the real root
// unchanged when isolation doesn't apply.
func (s PathScope) BaseDir() string {
	return s.applyRemap(s.root)
}

// Remap redirects an already-validated real absolute path into the conversation's
// worktree. Exposed for ops (shell cwd, git status) that resolve a path against
// the real root and then need the worktree location to execute in.
func (s PathScope) Remap(absPath string) string {
	return s.applyRemap(absPath)
}

// Resolve validates a requested path for a read/search/tree op, enforcing
// containment within the working directory OR any allowed root. These ops are
// NOT approval-gated, so the scope is the policy boundary and must self-enforce
// containment (including the allowed-roots grant). Write/edit ops use Sanitize
// instead — see the contrast below. The returned AbsPath is redirected into the
// conversation's worktree (containment having been checked in real space).
func (s PathScope) Resolve(requestedPath string) (*PathValidationResult, error) {
	result, err := ValidateFilePathWithRoots(s.root, s.allowedRoots, requestedPath)
	if err == nil && result != nil && result.IsValid {
		result.AbsPath = s.applyRemap(result.AbsPath)
	}
	return result, err
}

// ResolveReal is Resolve WITHOUT the worktree redirect: it validates containment
// and returns the real (pre-remap) absolute path. Search/tree ops use it to learn
// the real location a path maps to, so they can search the redirected worktree
// yet still report matches relative to the real project root.
func (s PathScope) ResolveReal(requestedPath string) (*PathValidationResult, error) {
	return ValidateFilePathWithRoots(s.root, s.allowedRoots, requestedPath)
}

// Sanitize cleans a requested path to absolute form WITHOUT enforcing
// containment, for write/edit ops. Those ops are gated by the JS approval flow
// (the user has already OK'd the write by the time the request lands), so the
// backend executes faithfully rather than re-imposing a sandbox that would also
// reject the legitimate out-of-project write the user just approved. Contrast
// Resolve, which is the gate for the non-approval-gated reads/search/tree. The
// returned path is redirected into the conversation's worktree; the real path is
// still what AuthorizeOutOfScopeWrite validates.
func (s PathScope) Sanitize(requestedPath string) (string, error) {
	abs, err := SanitizeAbsolutePath(s.root, requestedPath)
	if err != nil {
		return "", err
	}
	return s.applyRemap(abs), nil
}

// ResolveUserInitiated resolves a path for a non-approval-gated read/tree op,
// honouring the user-initiated escape hatch. A normal (LLM-driven) call enforces
// working-directory containment via Resolve. A user-initiated call — a pin the
// user created by @-mention or the file picker — has already crossed the user's
// explicit "I meant this path" boundary, so it resolves WITHOUT containment
// (Sanitize). That lets the pin reach a file or folder outside the project root
// whether the path is relative (e.g. ../sibling-repo) or absolute; the prior
// absolute-only hatch silently dropped relative mentions back into the sandbox.
// Out-of-root user-initiated access is logged for the audit trail.
func (s PathScope) ResolveUserInitiated(requestedPath string, userInitiated bool) (string, error) {
	if !userInitiated {
		result, err := s.Resolve(requestedPath)
		if err != nil {
			return "", err
		}
		return result.AbsPath, nil
	}
	abs, err := s.Sanitize(requestedPath)
	if err != nil {
		return "", err
	}
	// Audit the out-of-workdir case using the REAL path — abs may have been
	// redirected into a conversation worktree, which is legitimately outside the
	// project root and must not be logged as an escape.
	if realAbs, e := SanitizeAbsolutePath(s.root, requestedPath); e == nil {
		if rootAbs, e2 := filepath.Abs(s.root); e2 == nil {
			if real, e3 := filepath.EvalSymlinks(rootAbs); e3 == nil {
				rootAbs = real
			}
			if !pathWithinRoot(realAbs, rootAbs) {
				jlog.Info("ops: user-initiated out-of-workdir access: %s", realAbs)
			}
		}
	}
	return abs, nil
}

// resolveExistingPrefix returns absPath with as much symlink resolution as
// possible: walks up until it finds an existing component, EvalSymlinks that
// prefix, and re-attaches the missing tail. Used by ValidateFilePath so that
// callers passing an absolute path to a not-yet-existing file get the same
// canonical form (/private/var/...) as the already-resolved workingDirAbs.
func resolveExistingPrefix(absPath string) string {
	absPath = filepath.Clean(absPath)
	tail := ""
	prefix := absPath
	for {
		if _, err := os.Lstat(prefix); err == nil {
			if real, err := filepath.EvalSymlinks(prefix); err == nil {
				if tail == "" {
					return real
				}
				return filepath.Join(real, tail)
			}
			break
		}
		parent := filepath.Dir(prefix)
		if parent == prefix {
			break
		}
		tail = filepath.Join(filepath.Base(prefix), tail)
		prefix = parent
	}
	return absPath
}

// SanitizeAbsolutePath cleans and resolves a path to an absolute form without
// enforcing any working-directory containment. This is the path-handling helper
// for file-modifying ops (writeFile, editFile, …), where the JS-layer approval
// flow is the policy gate: by the time the request reaches the backend, the
// user has approved (explicitly via the modal, or implicitly via a standing
// permission). The backend's job is to execute faithfully, not to second-guess
// the gate with a sandbox that would also reject the legitimate /tmp write the
// user just OK'd. Reads/search/tree are not approval-gated and continue to use
// ValidateFilePath.
func SanitizeAbsolutePath(workingDir, requestedPath string) (string, error) {
	if requestedPath == "" {
		return "", fmt.Errorf("path cannot be empty")
	}
	var abs string
	if filepath.IsAbs(requestedPath) {
		abs = filepath.Clean(requestedPath)
	} else {
		// Relative paths resolve against the ops working directory, not the
		// process cwd — that's the project root the user is working in.
		base, err := filepath.Abs(workingDir)
		if err != nil {
			return "", fmt.Errorf("invalid working directory: %w", err)
		}
		abs = filepath.Join(base, requestedPath)
	}
	abs, err := filepath.Abs(abs)
	if err != nil {
		return "", fmt.Errorf("invalid path: %w", err)
	}
	// Resolve symlinks on the existing portion of the path so callers operate
	// on the real target (defence in depth — the policy gate above is the
	// primary check).
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	return abs, nil
}

// ValidateFilePath validates a file path is within working directory
// Returns the absolute path if valid, or an error if invalid
//
// Security checks:
// - Prevents directory traversal attacks
// - Ensures path is within working directory
// - Resolves symlinks to prevent symlink attacks
// - Handles edge cases like ".." sequences, etc.
//
// Used by read/search/tree ops, which are NOT approval-gated and so must
// enforce containment here. File-modifying ops use SanitizeAbsolutePath
// instead — see the doc comment there.
func ValidateFilePath(workingDir, requestedPath string) (*PathValidationResult, error) {
	return ValidateFilePathWithRoots(workingDir, nil, requestedPath)
}

// ValidateFilePathWithRoots is ValidateFilePath widened by a set of additional
// allowed roots. The path validates when it resolves inside the working
// directory OR inside any extraRoot. extraRoots carries the user's standing
// allowed-paths grant (see message-thread-permissions.js getAllowedPaths) so
// the same explicit grant that auto-approves shell commands also lets the
// non-approval-gated read/search/tree ops reach those locations. Blank entries
// are ignored so they can never widen access to the filesystem root.
func ValidateFilePathWithRoots(workingDir string, extraRoots []string, requestedPath string) (*PathValidationResult, error) {
	result := &PathValidationResult{
		RelPath: requestedPath,
	}

	// Resolve working directory to absolute path FIRST
	workingDirAbs, err := filepath.Abs(workingDir)
	if err != nil {
		result.ErrorMsg = fmt.Sprintf("failed to resolve working directory: %v", err)
		return result, fmt.Errorf("failed to resolve working directory: %w", err)
	}

	// Resolve working directory symlinks BEFORE joining with user path
	// This ensures we use the real path as the base
	realWorkingDir, err := filepath.EvalSymlinks(workingDirAbs)
	if err == nil {
		workingDirAbs = realWorkingDir
	}

	// Handle absolute vs relative paths
	// Absolute paths within the project are allowed; boundary check below validates
	var absPath string
	if filepath.IsAbs(requestedPath) {
		// Absolute path: clean it and validate against working directory below
		absPath = filepath.Clean(requestedPath)
	} else {
		// Relative path: join with working directory
		absPath = filepath.Join(workingDirAbs, requestedPath)
	}

	// Ensure absPath is absolute (Clean doesn't guarantee this for relative paths)
	absPath, err = filepath.Abs(absPath)
	if err != nil {
		result.ErrorMsg = fmt.Sprintf("invalid path: %v", err)
		return result, fmt.Errorf("invalid path: %w", err)
	}

	// CRITICAL: Evaluate symlinks to prevent symlink attacks
	// This resolves the path to its real location
	realPath, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		// If file doesn't exist yet, that's OK for some operations (like writes)
		// Use os.IsNotExist for cross-platform "file not found" detection
		if !os.IsNotExist(err) {
			result.ErrorMsg = fmt.Sprintf("failed to resolve symlinks: %v", err)
			return result, fmt.Errorf("failed to resolve symlinks: %w", err)
		}
		// File doesn't exist - resolve the longest existing prefix and
		// re-attach the missing tail so absPath ends up in the same
		// canonical form as workingDirAbs (which was already resolved
		// above). Without this, a caller that passes an absolute path
		// referencing not-yet-existing components (e.g. a write tool
		// pre-validating before the file is created) produces an
		// unresolved /var/folders/... while workingDirAbs is the
		// resolved /private/var/folders/..., and the prefix check
		// spuriously fires "outside working directory".
		absPath = resolveExistingPrefix(absPath)
	} else {
		// File exists - use the real path after symlink resolution
		absPath = realPath
	}

	// Build the set of roots the path may live under: the working directory
	// plus any caller-supplied allowed roots, each canonicalised to the same
	// symlink-resolved form as absPath so the prefix check compares like with
	// like.
	roots := make([]string, 0, 1+len(extraRoots))
	roots = append(roots, workingDirAbs)
	for _, r := range extraRoots {
		if strings.TrimSpace(r) == "" {
			continue
		}
		rootAbs, err := filepath.Abs(r)
		if err != nil {
			continue
		}
		if real, err := filepath.EvalSymlinks(rootAbs); err == nil {
			rootAbs = real
		} else if !os.IsNotExist(err) {
			continue
		} else {
			rootAbs = resolveExistingPrefix(rootAbs)
		}
		roots = append(roots, rootAbs)
	}

	for _, root := range roots {
		if pathWithinRoot(absPath, root) {
			result.AbsPath = absPath
			result.IsValid = true
			return result, nil
		}
	}

	result.ErrorMsg = "path is outside working directory (potential directory traversal attack)"
	return result, fmt.Errorf("path is outside working directory: requested %q resolved to %q, outside %q and %d allowed root(s)", requestedPath, absPath, workingDirAbs, len(roots)-1)
}

// pathWithinRoot reports whether absPath is the root itself or lives beneath it.
// root is suffixed with a separator before the prefix test so /workspace does
// not match /workspace-other.
func pathWithinRoot(absPath, root string) bool {
	if !strings.HasSuffix(root, string(filepath.Separator)) {
		root += string(filepath.Separator)
	}
	return strings.HasPrefix(absPath+string(filepath.Separator), root) ||
		strings.HasPrefix(absPath, root)
}

// pathWithinRootFold is pathWithinRoot with case-insensitive comparison on
// Windows (NTFS is case-insensitive by default, so C:\Proj and c:\proj are one
// location). On POSIX platforms it is exactly pathWithinRoot. Both operands are
// filepath.Clean'd first so native separators compare consistently.
func pathWithinRootFold(absPath, root string) bool {
	if runtime.GOOS == "windows" {
		return pathWithinRoot(strings.ToLower(filepath.Clean(absPath)), strings.ToLower(filepath.Clean(root)))
	}
	return pathWithinRoot(absPath, root)
}

// canonicalizeRoot resolves a root to the same symlink-resolved absolute form as
// resolveExistingPrefix produces for a target path, so the two compare like with
// like. A blank root yields "" (ignored by callers).
func canonicalizeRoot(root string) string {
	if strings.TrimSpace(root) == "" {
		return ""
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	} else if os.IsNotExist(err) {
		return resolveExistingPrefix(abs)
	}
	return abs
}

// withinScope reports whether an already-sanitised absolute path resolves inside
// the working directory OR any allowed root. This is the containment predicate
// for the write/edit defence-in-depth check (see AuthorizeOutOfScopeWrite):
// unlike reads, writes are approval-gated in JS and Sanitize does NOT enforce
// containment, so this is a second, independent boundary. The path and every
// root are canonicalised the same way as ValidateFilePathWithRoots so the prefix
// test compares like with like; on Windows the comparison folds case.
func (s PathScope) withinScope(absPath string) bool {
	target := resolveExistingPrefix(absPath)
	if root := canonicalizeRoot(s.root); root != "" && pathWithinRootFold(target, root) {
		return true
	}
	for _, extra := range s.allowedRoots {
		if root := canonicalizeRoot(extra); root != "" && pathWithinRootFold(target, root) {
			return true
		}
	}
	return false
}

// AuthorizeOutOfScopeWrite enforces the write/edit defence-in-depth boundary. A
// path inside the working directory or an allowed root is always fine. A path
// OUTSIDE all of them may be written only when the request is explicitly marked
// user-approved (approved==true) — which the JS layer sets solely on the
// modal-approved execution path, never from a standing permission rule. This
// keeps the "JS approval is the policy gate" contract while ensuring a JS bug
// (or a direct, unapproved op call) can't silently write anywhere on disk.
// Approved out-of-scope writes are logged for the audit trail (mirroring
// ResolveUserInitiated). kind is "write" or "edit", used only in the message.
func (s PathScope) AuthorizeOutOfScopeWrite(absPath, requestedPath, kind string, approved bool) error {
	// Validate the REAL path, not absPath: Sanitize may have redirected absPath
	// into a per-conversation worktree (which lives OUTSIDE the project root), so
	// checking it directly would spuriously demand approval for every ordinary
	// in-project write. Re-derive the real target from requestedPath so the
	// boundary is enforced in real-project space, exactly as before worktrees.
	real, err := SanitizeAbsolutePath(s.root, requestedPath)
	if err != nil {
		real = absPath // can't re-derive — fall back to the given path
	}
	if s.withinScope(real) {
		return nil
	}
	if !approved {
		return fmt.Errorf("%s outside project scope requires explicit approval: %q", kind, requestedPath)
	}
	jlog.Info("ops: out-of-scope %s approved: %s", kind, real)
	return nil
}

// ValidateSearchPattern validates a search/grep pattern
//
// Security: Prevents regex denial of service (ReDoS) attacks
// Checks for overly complex patterns that could cause CPU exhaustion
func ValidateSearchPattern(pattern string) error {
	if pattern == "" {
		return fmt.Errorf("search pattern cannot be empty")
	}

	// Check pattern length (prevent extremely long patterns)
	maxPatternLength := 1000
	if len(pattern) > maxPatternLength {
		return fmt.Errorf("search pattern too long (max %d characters)", maxPatternLength)
	}

	// Try to compile as regex to catch syntax errors early
	_, err := regexp.Compile(pattern)
	if err != nil {
		return fmt.Errorf("invalid regex pattern: %w", err)
	}

	// Check for potentially dangerous ReDoS patterns
	// These are simplified checks; real ReDoS detection is complex
	dangerousPatterns := []string{
		"(.*)*",   // Nested quantifiers
		"(.+)+",   // Nested quantifiers
		"(a*)*",   // Nested quantifiers
		"(a+)+",   // Nested quantifiers
		"(a|a)*",  // Overlapping alternation
		"(a|ab)*", // Overlapping alternation
	}

	for _, dangerous := range dangerousPatterns {
		if strings.Contains(pattern, dangerous) {
			return fmt.Errorf("pattern contains potentially dangerous regex construct: %s", dangerous)
		}
	}

	return nil
}

// ValidateIntParam validates an integer parameter is within bounds
func ValidateIntParam(value any, minVal, maxVal int, paramName string) (int, error) {
	// Handle different numeric types
	var intVal int

	switch v := value.(type) {
	case int:
		intVal = v
	case float64:
		intVal = int(v)
	case int64:
		intVal = int(v)
	case string:
		// Try to parse string as int
		var parsed int
		_, err := fmt.Sscanf(v, "%d", &parsed)
		if err != nil {
			return 0, fmt.Errorf("%s must be a number", paramName)
		}
		intVal = parsed
	default:
		return 0, fmt.Errorf("%s must be a number", paramName)
	}

	if intVal < minVal || intVal > maxVal {
		return 0, fmt.Errorf("%s must be between %d and %d", paramName, minVal, maxVal)
	}

	return intVal, nil
}

// ValidateStringParam validates a string parameter
func ValidateStringParam(value any, paramName string, required bool, maxLength int) (string, error) {
	strVal, ok := value.(string)
	if !ok {
		if required {
			return "", fmt.Errorf("%s must be a string, got %T", paramName, value)
		}
		// Return error for wrong type even when not required (strict validation)
		if value != nil {
			return "", fmt.Errorf("%s must be a string if provided, got %T", paramName, value)
		}
		return "", nil
	}

	if required && strVal == "" {
		return "", fmt.Errorf("%s cannot be empty", paramName)
	}

	if maxLength > 0 && len(strVal) > maxLength {
		return "", fmt.Errorf("%s too long (max %d characters)", paramName, maxLength)
	}

	return strVal, nil
}

// ValidateFileSize checks if a file is within the maximum size limit
// Returns an error if the file is too large
func ValidateFileSize(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		// File doesn't exist - that's OK for now
		return nil
	}

	if info.Size() > MaxFileSize {
		return fmt.Errorf("file too large: %d bytes (max %d bytes / %.1fMB)",
			info.Size(), MaxFileSize, float64(MaxFileSize)/(1024*1024))
	}

	return nil
}

// ValidateTreeDepth validates a tree depth parameter
func ValidateTreeDepth(depth any) (int, error) {
	depthInt, err := ValidateIntParam(depth, 1, MaxTreeDepth, "depth")
	if err != nil {
		return 0, err
	}

	return depthInt, nil
}

// IsBinaryFile detects if a file contains binary (non-text) content
// Returns true if the file appears to be binary
func IsBinaryFile(path string) (bool, error) {
	// Read first 512 bytes to detect binary content
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()

	buf := make([]byte, 512)
	n, err := file.Read(buf)
	if err != nil && n == 0 {
		return false, err
	}

	// A UTF-16 byte-order mark identifies a text file whose pervasive null bytes
	// would otherwise trip the null-byte heuristic below (every ASCII char in
	// UTF-16 carries a zero byte). Treat BOM'd UTF-16 as text; loadFile
	// transcodes it to UTF-8 for display via decodeTextBytes.
	if hasUTF16BOM(buf[:n]) {
		return false, nil
	}

	// Check for null bytes (strong indicator of binary content)
	for i := range n {
		if buf[i] == 0 {
			return true, nil
		}
	}

	// Check if content is valid UTF-8 (handles non-ASCII text properly)
	// Invalid UTF-8 sequences often indicate binary content
	// Note: We need to handle the case where the buffer ends mid-character.
	// A multi-byte UTF-8 sequence may be truncated at the 512-byte boundary.
	// We find the last complete UTF-8 sequence and validate only that portion.
	data := buf[:n]
	validLen := findLastCompleteUTF8(data)
	if validLen > 0 && !utf8.Valid(data[:validLen]) {
		return true, nil
	}

	// Count control characters (except tab, newline, carriage return)
	// UTF-8 text files shouldn't have many control characters
	nonPrintable := 0
	for i := range n {
		if buf[i] < 32 && buf[i] != 9 && buf[i] != 10 && buf[i] != 13 {
			nonPrintable++
		}
	}

	// If more than 30% control characters, likely binary
	if float64(nonPrintable)/float64(n) > 0.3 {
		return true, nil
	}

	return false, nil
}

// findLastCompleteUTF8 finds the length of data up to the last complete UTF-8 sequence.
// If the buffer ends with an incomplete multi-byte sequence, this returns the length
// excluding those trailing bytes.
func findLastCompleteUTF8(data []byte) int {
	n := len(data)
	if n == 0 {
		return 0
	}

	// Check if we need to truncate trailing incomplete UTF-8
	// UTF-8 encoding:
	// - 0xxxxxxx: single byte (ASCII)
	// - 10xxxxxx: continuation byte
	// - 110xxxxx: start of 2-byte sequence
	// - 1110xxxx: start of 3-byte sequence
	// - 11110xxx: start of 4-byte sequence

	// Scan backwards from the end to find incomplete sequences
	// We need to check at most 3 bytes back (max incomplete = 3 bytes of a 4-byte seq)
	for i := 1; i <= 3 && i <= n; i++ {
		b := data[n-i]
		if b < 0x80 {
			// ASCII byte - everything up to here is complete
			return n
		}
		if b >= 0xC0 {
			// This is a start byte - check if sequence is complete
			var expectedLen int
			if b < 0xE0 {
				expectedLen = 2
			} else if b < 0xF0 {
				expectedLen = 3
			} else {
				expectedLen = 4
			}
			// If the remaining bytes (i) are less than expected, truncate here
			if i < expectedLen {
				return n - i
			}
			// Sequence is complete
			return n
		}
		// Continuation byte (10xxxxxx) - keep scanning backwards
	}

	// If we scanned 3 continuation bytes without finding a start byte,
	// something is wrong - but return full length and let utf8.Valid catch it
	return n
}

// hasUTF16BOM reports whether b begins with a UTF-16 little- or big-endian
// byte-order mark (FF FE / FE FF).
func hasUTF16BOM(b []byte) bool {
	return len(b) >= 2 &&
		((b[0] == 0xFF && b[1] == 0xFE) || (b[0] == 0xFE && b[1] == 0xFF))
}

// decodeTextBytes converts raw file bytes to UTF-8 text, honouring a leading
// byte-order mark. UTF-16LE/BE (common on Windows — PowerShell `>` redirection,
// Notepad "Unicode" saves, many .reg/registry exports and logs) is transcoded
// to UTF-8, and a UTF-8 BOM is stripped. Bytes without a recognised BOM are
// returned unchanged (already UTF-8/ASCII on the platforms we target). On a
// decode error the original bytes are returned, so the caller degrades to the
// prior behaviour rather than losing content.
func decodeTextBytes(raw []byte) []byte {
	switch {
	case hasUTF16BOM(raw):
		// UseBOM consumes the leading BOM and derives the endianness from it,
		// so a single decoder handles both LE and BE inputs.
		dec, err := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder().Bytes(raw)
		if err != nil {
			return raw
		}
		return dec
	case len(raw) >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF:
		return raw[3:] // strip UTF-8 BOM
	default:
		return raw
	}
}
