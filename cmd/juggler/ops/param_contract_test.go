//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The params an op is called with come from a model's tool call, and an op's
// error text goes straight back to the model as the tool result. So both are a
// contract: the exact words a bad param earns, and what a param of the wrong
// type does when the op tolerates it (most read a flag with `v, _ := p.(bool)`
// and treat anything else as absent). TestParamContract pins both, through
// Execute, for the file, tree, search and shell ops.

// executor is what each op set exposes: the one dispatch a real call takes.
type executor interface {
	Execute(ctx context.Context, operation string, params map[string]any) (any, error)
}

// paramCase is one call. Exactly one of wantErr, sameAs and check says what
// it must do.
type paramCase struct {
	name   string
	op     string
	params map[string]any
	// wantErr is the exact error text the call returns.
	wantErr string
	// sameAs is a call whose result this one must equal: the tolerated value
	// is read as if it were absent (or the losing alias as if it were not
	// there).
	sameAs map[string]any
	// check inspects a call whose effect is the point rather than its result.
	check func(t *testing.T, res any, err error)
}

// paramFixture is a project with a small text file and a Go file in a
// subdirectory, enough for every op below to have something to find.
func paramFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	write := func(rel, body string) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt", "one\ntwo\nthree\nfour\nfive\n")
	write("sub/b.go", "package sub\n\nfunc Hello() {}\n")
	return dir
}

// shellView keeps the parts of a shell result that are the command's own, not
// the run's (a spill path or duration would differ between two runs).
func shellView(res any) any {
	m, ok := res.(map[string]any)
	if !ok {
		return res
	}
	return map[string]any{"stdout": m["stdout"], "exitCode": m["exitCode"]}
}

func runParamCases(t *testing.T, ex executor, view func(any) any, cases []paramCase) {
	t.Helper()
	ctx := context.Background()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, err := ex.Execute(ctx, c.op, c.params)
			switch {
			case c.check != nil:
				c.check(t, res, err)
			case c.sameAs != nil:
				if err != nil {
					t.Fatalf("%s(%v): %v", c.op, c.params, err)
				}
				want, wantErr := ex.Execute(ctx, c.op, c.sameAs)
				if wantErr != nil {
					t.Fatalf("%s(%v), the call it is held to: %v", c.op, c.sameAs, wantErr)
				}
				if got, want := view(res), view(want); !reflect.DeepEqual(got, want) {
					t.Errorf("%s(%v) differs from %s(%v):\n got  %v\n want %v", c.op, c.params, c.op, c.sameAs, got, want)
				}
			default:
				if err == nil {
					t.Fatalf("%s(%v) succeeded; want error %q", c.op, c.params, c.wantErr)
				}
				if err.Error() != c.wantErr {
					t.Errorf("%s(%v) error:\n got  %q\n want %q", c.op, c.params, err.Error(), c.wantErr)
				}
			}
		})
	}
}

func identity(v any) any { return v }

func TestParamContract(t *testing.T) {
	dir := paramFixture(t)
	scope := NewPathScope(dir, nil)
	a := filepath.Join(dir, "a.txt")
	long := strings.Repeat("a", 4097)

	t.Run("file", func(t *testing.T) {
		runParamCases(t, NewFileOperations(scope), identity, []paramCase{
			// loadFile
			{name: "loadFile path missing", op: "loadFile", params: map[string]any{},
				wantErr: "path must be a string, got <nil>"},
			{name: "loadFile path not a string", op: "loadFile", params: map[string]any{"path": 5},
				wantErr: "path must be a string, got int"},
			{name: "loadFile path empty", op: "loadFile", params: map[string]any{"path": ""},
				wantErr: "path cannot be empty"},
			{name: "loadFile path too long", op: "loadFile", params: map[string]any{"path": long},
				wantErr: "path too long (max 4096 characters)"},
			{name: "loadFile around without a numeric line", op: "loadFile",
				params:  map[string]any{"path": a, "around": map[string]any{"line": "2"}},
				wantErr: "around mode requires a valid 'line' parameter"},
			{name: "loadFile lineRange without an end", op: "loadFile",
				params:  map[string]any{"path": a, "lineRange": map[string]any{"start": 1.0}},
				wantErr: "lineRange requires valid 'start' and 'end' parameters"},
			{name: "loadFile lineRange reversed", op: "loadFile",
				params:  map[string]any{"path": a, "lineRange": map[string]any{"start": 3.0, "end": 1.0}},
				wantErr: "invalid line range: start (3) must be <= end (1)"},
			{name: "loadFile raw not a bool", op: "loadFile",
				params: map[string]any{"path": a, "raw": "yes"}, sameAs: map[string]any{"path": a}},
			{name: "loadFile userInitiated not a bool", op: "loadFile",
				params: map[string]any{"path": a, "userInitiated": "yes"}, sameAs: map[string]any{"path": a}},
			{name: "loadFile tail as an int", op: "loadFile",
				params: map[string]any{"path": a, "tail": 2}, sameAs: map[string]any{"path": a}},
			{name: "loadFile tail as a string", op: "loadFile",
				params: map[string]any{"path": a, "tail": "2"}, sameAs: map[string]any{"path": a}},
			{name: "loadFile head as an int", op: "loadFile",
				params: map[string]any{"path": a, "head": 2}, sameAs: map[string]any{"path": a}},
			{name: "loadFile maxLines as an int", op: "loadFile",
				params: map[string]any{"path": a, "maxLines": 2}, sameAs: map[string]any{"path": a}},
			{name: "loadFile around not an object", op: "loadFile",
				params: map[string]any{"path": a, "around": "2"}, sameAs: map[string]any{"path": a}},
			{name: "loadFile lineRange not an object", op: "loadFile",
				params: map[string]any{"path": a, "lineRange": []any{1.0, 2.0}}, sameAs: map[string]any{"path": a}},
			{name: "loadFile tail wins over head", op: "loadFile",
				params: map[string]any{"path": a, "tail": 2.0, "head": 3.0}, sameAs: map[string]any{"path": a, "tail": 2.0}},
			{name: "loadFile a float tail is read", op: "loadFile", params: map[string]any{"path": a, "tail": 2.0},
				check: func(t *testing.T, res any, err error) {
					if err != nil {
						t.Fatal(err)
					}
					// The control for the tolerated tails above: a float one is read,
					// so they would differ from a plain read if they were too.
					content, _ := res.(map[string]any)["content"].(string)
					if strings.Contains(content, "one") || !strings.Contains(content, "five") {
						t.Fatalf("tail 2 did not read just the end of the file: %q", content)
					}
				}},

			// writeFile
			{name: "writeFile path missing", op: "writeFile", params: map[string]any{},
				wantErr: "invalid path parameter: path must be a string, got <nil>"},
			{name: "writeFile content not a string", op: "writeFile",
				params:  map[string]any{"path": filepath.Join(dir, "w.txt"), "content": 5},
				wantErr: "invalid content parameter: content must be a string if provided, got int"},
			{name: "writeFile dryRun not a bool writes", op: "writeFile",
				params: map[string]any{"path": filepath.Join(dir, "w.txt"), "content": "x", "dryRun": "yes"},
				check: func(t *testing.T, _ any, err error) {
					if err != nil {
						t.Fatal(err)
					}
					if body, rerr := os.ReadFile(filepath.Join(dir, "w.txt")); rerr != nil || string(body) != "x" {
						t.Fatalf("a non-bool dryRun must write as no dryRun does; file holds %q (%v)", body, rerr)
					}
				}},

			// editFile
			{name: "editFile old_str missing", op: "editFile", params: map[string]any{"path": a},
				wantErr: "invalid old_str parameter: old_str must be a string, got <nil>"},
			{name: "editFile old_str empty", op: "editFile", params: map[string]any{"path": a, "old_str": ""},
				wantErr: "invalid old_str parameter: old_str cannot be empty"},
			{name: "editFile new_str not a string", op: "editFile",
				params:  map[string]any{"path": a, "old_str": "one", "new_str": 5},
				wantErr: "invalid new_str parameter: new_str must be a string if provided, got int"},
			{name: "editFile no-op", op: "editFile",
				params:  map[string]any{"path": a, "old_str": "one", "new_str": "one"},
				wantErr: "old_str and new_str are identical, this edit is a no-op"},
			{name: "editFile replace_all not a bool", op: "editFile",
				params: map[string]any{"path": a, "old_str": "two", "new_str": "2", "dryRun": true, "replace_all": "yes"},
				sameAs: map[string]any{"path": a, "old_str": "two", "new_str": "2", "dryRun": true}},
			{name: "editFile expectedHash not a string", op: "editFile",
				params: map[string]any{"path": a, "old_str": "two", "new_str": "2", "dryRun": true, "expectedHash": 7},
				sameAs: map[string]any{"path": a, "old_str": "two", "new_str": "2", "dryRun": true}},

			// editFileLines
			{name: "editFileLines startLine missing", op: "editFileLines", params: map[string]any{"path": a},
				wantErr: "missing or invalid startLine parameter (must be a number)"},
			{name: "editFileLines startLine as an int", op: "editFileLines", params: map[string]any{"path": a, "startLine": 1},
				wantErr: "missing or invalid startLine parameter (must be a number)"},
			{name: "editFileLines startLine zero", op: "editFileLines", params: map[string]any{"path": a, "startLine": 0.0},
				wantErr: "startLine must be greater than 0"},
			{name: "editFileLines newContent not a string", op: "editFileLines",
				params:  map[string]any{"path": a, "startLine": 1.0, "newContent": 5},
				wantErr: "invalid newContent parameter: newContent must be a string if provided, got int"},
			{name: "editFileLines endLine zero", op: "editFileLines",
				params:  map[string]any{"path": a, "startLine": 1.0, "newContent": "x", "dryRun": true, "endLine": 0.0},
				wantErr: "provided endLine (0) must be greater than 0, or omit endLine to replace to the end of the file"},
			{name: "editFileLines endLine as an int", op: "editFileLines",
				params: map[string]any{"path": a, "startLine": 1.0, "newContent": "x", "dryRun": true, "endLine": 2},
				sameAs: map[string]any{"path": a, "startLine": 1.0, "newContent": "x", "dryRun": true}},
			{name: "editFileLines contextLine as an int", op: "editFileLines",
				params: map[string]any{"path": a, "startLine": 1.0, "newContent": "x", "dryRun": true, "contextLine": 1, "contextText": "nope"},
				sameAs: map[string]any{"path": a, "startLine": 1.0, "newContent": "x", "dryRun": true}},
			{name: "editFileLines contextText not a string", op: "editFileLines",
				params: map[string]any{"path": a, "startLine": 1.0, "newContent": "x", "dryRun": true, "contextLine": 1.0, "contextText": 5},
				sameAs: map[string]any{"path": a, "startLine": 1.0, "newContent": "x", "dryRun": true, "contextLine": 1.0}},

			// getFileHash, stat, mkdir
			{name: "getFileHash path missing", op: "getFileHash", params: map[string]any{},
				wantErr: "path must be a string, got <nil>"},
			{name: "stat path not a string", op: "stat", params: map[string]any{"path": 5},
				wantErr: "path must be a string, got int"},
			{name: "mkdir path empty", op: "mkdir", params: map[string]any{"path": ""},
				wantErr: "path cannot be empty"},
			{name: "mkdir recursive not a bool is not recursive", op: "mkdir",
				params: map[string]any{"path": filepath.Join(dir, "m", "n"), "recursive": "yes"},
				check: func(t *testing.T, _ any, err error) {
					if err == nil {
						t.Fatal("a non-bool recursive must not create missing parents")
					}
					if _, serr := os.Stat(filepath.Join(dir, "m")); serr == nil {
						t.Fatal("the parent was created")
					}
				}},
		})
	})

	t.Run("tree", func(t *testing.T) {
		runParamCases(t, NewTreeOperations(scope), identity, []paramCase{
			{name: "getTree depth out of range", op: "getTree", params: map[string]any{"depth": 0.0},
				wantErr: "depth must be between 1 and 50"},
			{name: "getTree depth not a number", op: "getTree", params: map[string]any{"depth": "deep"},
				wantErr: "depth must be a number"},
			{name: "getTree depth a bool", op: "getTree", params: map[string]any{"depth": true},
				wantErr: "depth must be a number"},
			{name: "getTree maxTokens not a number", op: "getTree", params: map[string]any{"maxTokens": "5"},
				wantErr: "maxTokens must be a number, got string"},
			{name: "getTree pattern not a string", op: "getTree", params: map[string]any{"pattern": 5.0},
				wantErr: "pattern must be a string, got float64"},
			{name: "getTree fileType not a string", op: "getTree", params: map[string]any{"fileType": true},
				wantErr: "fileType must be a string, got bool"},
			{name: "getTree showAll not a bool", op: "getTree", params: map[string]any{"showAll": "yes"},
				wantErr: "showAll must be a boolean, got string"},
			{name: "getTree noIgnore not a bool", op: "getTree", params: map[string]any{"noIgnore": 1.0},
				wantErr: "noIgnore must be a boolean, got float64"},
			{name: "getTree depth as an int", op: "getTree",
				params: map[string]any{"depth": 3}, sameAs: map[string]any{"depth": 3.0}},
			{name: "getTree depth as an int64", op: "getTree",
				params: map[string]any{"depth": int64(3)}, sameAs: map[string]any{"depth": 3.0}},
			{name: "getTree depth as a numeric string", op: "getTree",
				params: map[string]any{"depth": "3"}, sameAs: map[string]any{"depth": 3.0}},
			{name: "getTree path not a string", op: "getTree",
				params: map[string]any{"path": 5}, sameAs: map[string]any{}},
			{name: "getTree path empty", op: "getTree",
				params: map[string]any{"path": ""}, sameAs: map[string]any{}},
			{name: "getTree fileType unknown", op: "getTree",
				params: map[string]any{"fileType": "bogus"}, sameAs: map[string]any{}},
			{name: "getTree noIgnore false", op: "getTree",
				params: map[string]any{"noIgnore": false}, sameAs: map[string]any{}},

			{name: "glob pattern missing", op: "glob", params: map[string]any{},
				wantErr: "pattern is required"},
			{name: "glob pattern empty", op: "glob", params: map[string]any{"pattern": ""},
				wantErr: "pattern is required"},
			{name: "glob pattern not a string", op: "glob", params: map[string]any{"pattern": 5},
				wantErr: "pattern is required"},
			{name: "glob path not a string", op: "glob",
				params: map[string]any{"pattern": "**/*.go", "path": 5}, sameAs: map[string]any{"pattern": "**/*.go"}},
			{name: "glob noIgnore not a bool", op: "glob",
				params: map[string]any{"pattern": "**/*.go", "noIgnore": "yes"}, sameAs: map[string]any{"pattern": "**/*.go"}},

			{name: "expandDirectory path missing", op: "expandDirectory", params: map[string]any{},
				wantErr: "missing or invalid 'path' parameter"},
			{name: "expandDirectory path not a string", op: "expandDirectory", params: map[string]any{"path": 5},
				wantErr: "missing or invalid 'path' parameter"},
		})
	})

	t.Run("search", func(t *testing.T) {
		runParamCases(t, NewSearchOperations(scope), identity, []paramCase{
			{name: "grep pattern missing", op: "grep", params: map[string]any{},
				wantErr: "missing or invalid 'pattern' parameter"},
			{name: "grep pattern not a string", op: "grep", params: map[string]any{"pattern": 5},
				wantErr: "missing or invalid 'pattern' parameter"},
			{name: "grep pattern empty", op: "grep", params: map[string]any{"pattern": ""},
				wantErr: "invalid search pattern: search pattern cannot be empty"},
			{name: "grep maxCount as an int", op: "grep",
				params: map[string]any{"pattern": "e", "maxCount": 1}, sameAs: map[string]any{"pattern": "e"}},
			{name: "grep maxCount wins over maxResults", op: "grep",
				params: map[string]any{"pattern": "e", "maxCount": 1.0, "maxResults": 50.0},
				sameAs: map[string]any{"pattern": "e", "maxCount": 1.0}},
			{name: "grep include wins over filePattern", op: "grep",
				params: map[string]any{"pattern": "e", "include": "*.txt", "filePattern": "*.go"},
				sameAs: map[string]any{"pattern": "e", "include": "*.txt"}},
			{name: "grep ignoreCase not a bool", op: "grep",
				params: map[string]any{"pattern": "E", "ignoreCase": "no"}, sameAs: map[string]any{"pattern": "E"}},
			{name: "grep path not a string", op: "grep",
				params: map[string]any{"pattern": "e", "path": 5}, sameAs: map[string]any{"pattern": "e"}},

			{name: "findSymbol symbol missing", op: "findSymbol", params: map[string]any{},
				wantErr: "missing or invalid 'symbol' parameter"},
			{name: "findSymbol noIgnore not a bool", op: "findSymbol",
				params: map[string]any{"symbol": "Hello", "noIgnore": "yes"}, sameAs: map[string]any{"symbol": "Hello"}},
		})
	})

	t.Run("shell", func(t *testing.T) {
		requirePOSIXShell(t)
		runParamCases(t, NewShellOperations(scope), shellView, []paramCase{
			{name: "execute command missing", op: "execute", params: map[string]any{},
				wantErr: "missing 'command' or 'code' parameter"},
			{name: "execute command not a string", op: "execute", params: map[string]any{"command": 5},
				wantErr: "missing 'command' or 'code' parameter"},
			{name: "execute no-deadline timeout", op: "execute", params: map[string]any{"command": "echo hi", "timeout": -1.0},
				wantErr: "timeout -1 asks for no deadline, which only a background task can have"},
			{name: "execute no-deadline timeout as an int", op: "execute",
				params: map[string]any{"command": "echo hi", "timeout": -1}, sameAs: map[string]any{"command": "echo hi"}},
			{name: "execute code not a string runs the command", op: "execute",
				params: map[string]any{"command": "echo hi", "code": 5}, sameAs: map[string]any{"command": "echo hi"}},
			{name: "execute cwd not a string", op: "execute",
				params: map[string]any{"command": "pwd", "cwd": 5}, sameAs: map[string]any{"command": "pwd"}},
			{name: "execute convId not a string", op: "execute",
				params: map[string]any{"command": "echo hi", "convId": 5}, sameAs: map[string]any{"command": "echo hi"}},

			{name: "startBackground command missing", op: "startBackground", params: map[string]any{},
				wantErr: "missing command parameter"},
			{name: "startBackground command empty", op: "startBackground", params: map[string]any{"command": ""},
				wantErr: "missing command parameter"},
			{name: "startBackground ids not strings", op: "startBackground",
				params: map[string]any{"command": "true", "convId": 5, "toolUseId": 6},
				check: func(t *testing.T, res any, err error) {
					if err != nil {
						t.Fatal(err)
					}
					id, _ := res.(map[string]any)["task_id"].(string)
					if id == "" {
						t.Fatalf("no task started: %v", res)
					}
					t.Cleanup(func() { KillTask(id) })
				}},
		})
	})
}
