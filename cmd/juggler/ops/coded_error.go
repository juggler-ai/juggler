//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

// CodedError is an operation failure a caller may need to tell apart from
// other failures without reading its prose. It is an error like any other: the
// operation fails, and the message is written for whoever reads the failure
// (usually the model). The code is the stable contract, and the detail carries
// any values the caller needs to act on the code.
//
// The ops API sends the code and detail beside the message
// (handlers.OperationResponse), and ops-api.js surfaces them on OpsError as
// `code` and `detail`. What a caller does with a code is its own business: an
// op says what went wrong, never how it should be shown.
type CodedError struct {
	Code   string
	Msg    string
	Detail map[string]any
}

func (e *CodedError) Error() string { return e.Msg }

// CodeSearchNotFound is an edit whose old_str matches nothing in the file. Its
// detail carries `path` and `contentHash` (the file's current bytes), so a
// caller can tell a stale read from a wrong old_str.
const CodeSearchNotFound = "SEARCH_NOT_FOUND"
