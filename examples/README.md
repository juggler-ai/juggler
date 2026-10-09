# Example extensions

Small Juggler extensions, written to be read in one sitting and copied. Between
them they cover every capability type; none of them is enabled — or even shipped
— by default.

These are **Apache-2.0** (see [`LICENSE`](LICENSE)), so you can lift any of them
into your own extension with no copyleft obligation, whatever licence you ship
under.

| Example | Demonstrates |
|---------|--------------|
| [`extensions/hello-tool`](extensions/hello-tool) | A context item: the smallest useful tool the model can call |
| [`extensions/focus-strategy`](extensions/focus-strategy) | A strategy: gating tools and auto-approving what survives |
| [`extensions/csv-viewer`](extensions/csv-viewer) | A file viewer: `render()` for you, `extract()` for the model |
| [`extensions/nono-denials`](extensions/nono-denials) | A hook: a note for the model after every call a sandbox refused |
| [`extensions/bookmarks`](extensions/bookmarks) | Four capabilities at once — tools, an approval gate, a **command**, an **info card** and a setting. The end state of the [tutorial](../docs/extension_tutorial.md) |

Commands and info cards have no standalone example: they are small enough that
seeing them alongside the tools they belong with, in `bookmarks`, teaches more
than seeing them alone.

## Running one

```bash
juggler ext validate ./examples/extensions/hello-tool   # check it before installing
juggler ext link ./examples/extensions/hello-tool       # symlink into ~/.juggler/extensions
```

Start or reconnect to Juggler and it loads. From then on, editing any file
hot-reloads it in connected viewers — no restart. To remove it again, delete the
symlink from `~/.juggler/extensions/`.

## Where to go next

- [`docs/extension_tutorial.md`](../docs/extension_tutorial.md) — builds the
  `bookmarks` example from nothing, one capability at a time.
- [`docs/extension_guide.md`](../docs/extension_guide.md) — the reference: the
  manifest, the trust model, every capability type.
- `web/sdk/*.js` — the base classes. Each opens with a quickstart and a full
  method reference, and is the canonical API documentation.
- `web/extensions/juggler-core/` — the built-in extension. Much bigger than
  anything here, and the best place to see real-world detail.

These examples are linted, type-checked and validated by the repository's own
test suite, so they stay in step with the SDK rather than rotting quietly.
