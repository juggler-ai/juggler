# The genai fork

Juggler talks to Gemini through Google's
[Go SDK](https://github.com/googleapis/go-genai), `google.golang.org/genai`. It
builds against `3rdparty/genai`, a copy of the v1.79.1 release with two files
taken out, wired in by a `replace` in `go.mod`. The copy is plain files, not a
submodule: the release's non-test Go source (without `examples/`), its
`LICENSE` (Apache-2.0), and its `go.mod`/`go.sum`. No file in it is edited.

## The change

**`replay_api_client.go` and `replay_sanitizer.go` are left out.** They are
the record/replay client the SDK's own tests run against. Nothing outside the
SDK's tests uses them, but they are ordinary files of package `genai`, so every
program importing the SDK links them, along with `testing`,
`net/http/httptest` and `github.com/google/go-cmp`. Their package-level
`cmp.Comparer` variables run at start-up, which keeps go-cmp's type printing
reachable. That code calls `reflect.Type.Method` with an index the linker
cannot see, so the linker keeps every exported method of every type the binary
uses, rather than only the ones it calls. In Juggler's server that is most of
the OpenAI and Anthropic SDKs' unused API surface. It is the one such cause no
build tag or code of Juggler's own can remove; `BUILD_TAGS` in
`mk/build-flags.mk` lists the others. With all of them gone, the stripped
server shrinks from 118 to 84 MB.

Upstream, the fix is to rename the two files to `_test.go`, where the tests
that use them still see them. Their exported `InternalReplayAPIClient`,
`NewInternalReplayAPIClient` and `InternalReadFileForReplayTest` would go
from the package's API; nothing else in the module uses them.

To check the change still holds after an update, build the server with the
release tags and `-ldflags=-dumpdep`, and run
`github.com/aarzilli/whydeadcode` over the output. It should name nothing
but `encoding/json/v2`'s `addressableValue` methods, which it reports
wrongly: they do not stop the pruning.

## Upstream

As of 2026-11-28 there is no upstream issue or PR; v1.79.1 is the latest
release and `main` has the same files.

**Update the copy** by repeating how it was made: copy the new release's
non-test `.go` files (excluding `examples/`, `tests/`, `testdata/` and the
two files above), its `LICENSE`, `go.mod` and `go.sum` over `3rdparty/genai`,
bump the version in `go.mod` here and in any module that repeats the
`replace`, and run `go mod tidy`.

**Drop the copy** once a release no longer links them. Delete `3rdparty/genai`,
remove the `replace` lines, require that release, and run `go mod tidy`. Then
remove this page and its mentions in `LICENSING.md`, `CONTRIBUTING.md` and
`AGENTS.md`.
