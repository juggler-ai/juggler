# Licensing

This repository contains code under two licenses. The split exists so that the
extension API is maximally permissive — you can build anything on it, including
closed-source extensions — while the application itself remains strong copyleft.

## The map

| Path | License | What it is |
|---|---|---|
| `web/sdk/**` | [Apache-2.0](web/sdk/LICENSE) | The extension SDK: the `juggler/*` modules extensions import, plus their support library in `web/sdk/lib/`. |
| `web/extensions/**` | [Apache-2.0](web/extensions/LICENSE) | Bundled extensions, including `juggler-core` — the reference implementation of Juggler's built-in tools, and the best starting point for writing your own. |
| `examples/**` | [Apache-2.0](examples/LICENSE) | Example extensions, written to be copied. Not shipped in any binary. |
| `cmd/juggler/providers/modelsdev/snapshot.json` | [MIT](cmd/juggler/providers/modelsdev/MODELS-DEV-LICENSE) | Third-party data: a trimmed snapshot of the [models.dev](https://models.dev) model catalogue, compiled into the app. |
| Everything else | [AGPL-3.0-or-later](LICENSE) | The application: Go server and desktop app, web UI, build tooling, tests, docs. |

Every source file carries an SPDX identifier and a license line in its header;
the per-directory `LICENSE` files above are authoritative for their trees.

## What this means for extension authors

Extension code imports the SDK through the `juggler/*` module specifiers (see
`docs/extension_guide.md`). Those modules — and everything under `web/sdk/lib/`
— are Apache-2.0, so an extension built against them incurs **no copyleft
obligation**: you may license your own extension however you like, closed
source included. Forking files from `examples/` or
`web/extensions/juggler-core/` as a starting point is equally unencumbered —
the `examples/` tree exists for exactly that.

The AGPL applies to the application that *hosts* your extension, not to your
extension. Running your extension inside Juggler is use of the app, which the
AGPL does not restrict; distributing your extension distributes none of
Juggler's AGPL code.

## Boundary audit

The SDK/app dependency boundary is enforced by lint: a relative import from
`web/sdk/**` into the AGPL `web/js/**` tree, or from a bundled extension into
`web/js/**` or `web/sdk/lib/**`, fails unless it is declared, with its reason,
in `tooling/sdk-boundary.json`. The lists below are rendered from that file.

<!-- sdk-boundary:begin — rendered from tooling/sdk-boundary.json by TestLicensingBoundaryAudit (web/sdk_boundary_test.go); UPDATE=1 rewrites it -->
- **Self-contained**: these SDK entry modules import no app code: `sdk/coerce-schema-types.js`, `sdk/command-type.js`, `sdk/context-item-types.js`, `sdk/context-item.js`, `sdk/file-viewer.js`, `sdk/hook-type.js`, `sdk/i18n-worker.js`, `sdk/i18n.js`, `sdk/info-card-type.js`, `sdk/item-utils-worker.js`, `sdk/item-utils.js`, `sdk/pinboard-item-type.js`, `sdk/sandbox.js`, `sdk/version.js`, `sdk/workspace-provider.js`. Nothing under `sdk/lib/` imports app code either, except where listed next.
- **Declared host bindings**: the SDK is the *interface* to a running Juggler
  host, and these modules bind it to the host's AGPL implementation:
  - `sdk/file-source.js` → `js/utils/api-url.js` — addresses the host's file-content, tree and asset endpoints under its base path
  - `sdk/lib/sandbox-runner.js` → `js/utils/api-url.js` — addresses the host's sandbox page under its base path
  - `sdk/model.js` → `js/utils/compaction-utils.js` — the compaction lifecycle is the host's
  - `sdk/ops.js` → `js/services/fs.js`, `js/services/ops-api.js`, `js/services/shell-streaming.js` — the host operations themselves
  - `sdk/pinboard.js` → `js/services/extensions.js`, `js/services/pinboard-operations-api.js`, `js/utils/asset-url.js` — pins go to the host's board; pin descriptors come from the loaded extensions
  - `sdk/registry.js` → `js/registries/context-item-registry.js`, `js/registries/file-viewer-registry.js`, `js/registries/strategy-registry.js` — the host's capability registries
  - `sdk/strategy-type.js` → `js/services/thread-orchestrator.js` — a strategy submits its turn through the host's orchestrator
  - `sdk/ui-worker.js` → `js/services/key-shortcut-manager.js`, `js/utils/asset-url.js`, `js/utils/format.js` — the DOM-free subset of the ui.js bindings, for the engine worker
  - `sdk/ui.js` → `js/components/diff-viewer.js`, `js/components/project-picker.js`, `js/components/reveal-button.js`, `js/components/review-panel.js`, `js/services/key-shortcut-manager.js`, `js/services/nearest-context-item.js`, `js/utils/asset-url.js`, `js/utils/format.js`, `js/utils/image-lightbox.js`, `js/utils/menu-roles.js`, `js/utils/popup-surface.js`, `js/utils/properties-panel-helpers.js` — the host's own UI components and formatters, so an extension's UI matches the app's
- **Bundled extensions that reach past the SDK**: every other module under
  `extensions/` reaches the host only through `juggler/*` specifiers, as a
  third-party extension must. These are the exceptions — mostly built-ins that
  are part of the app's own features — and are not templates for those parts:
  - `extensions/juggler-core/cards/git-status-card.js` → `js/services/git-status-cache.js`, `js/services/pinboard-view.js` — shows the host's git-status cache, shared with the app's own git UI
  - `extensions/juggler-core/cards/usage-card.js` → `js/services/default-model-cache.js`, `js/services/providers-cache.js`, `js/services/usage-stats-cache.js`, `js/utils/usage-renderer.js` — shows the host's provider, model and usage caches
  - `extensions/juggler-core/context-items/define-command-context-item.js` → `js/services/user-commands.js` — writes to the host's user-command store
  - `extensions/juggler-core/context-items/edit/permission-section.js` → `js/services/file-editing-permission.js` — the host's file-editing permission toggle
  - `extensions/juggler-core/context-items/skill-context-item.js` → `js/components/settings/skill-preview.js`, `js/services/skills.js` — reads the host's skill store and opens its settings preview
  - `extensions/juggler-core/context-items/system-prompt-context-item.js` → `js/services/extensions.js`, `js/services/mcp-availability.js`, `js/services/thread-tool-inventory.js`, `js/services/worker-manager.js`, `js/utils/transaction-anchor.js`, `sdk/lib/system-prompt-registry.js` — assembles the host's own system prompt: preset registry, extension contributions, tool inventory, MCP state and the transcript of the last turn sent
  - `extensions/juggler-core/context-items/system-prompt/preset-browser.js` → `js/services/system-prompt-presets.js`, `sdk/lib/system-prompt-registry.js` — edits the host's system-prompt presets
  - `extensions/juggler-core/strategies/auto-approve-strategy-type.js` → `js/services/file-editing-permission.js` — reads the host's file-editing permission toggle
  - `extensions/juggler-core/viewers/pdf-file-viewer.js` → `js/vendor/pdf.min.mjs` — loads the vendored PDF.js (Apache-2.0, web/js/vendor/README.md) on demand; not app code
  - `extensions/juggler-core/workspaces/git-worktree-workspace-provider.js` → `js/services/api.js` — asks the host's git-status endpoint; the SDK has no git API
  - `extensions/juggler-mcp/context-items/mcp-tool-context-item.js` → `js/services/websocket.js` — listens for the host's plugin-changed push; the SDK has no server-event subscription
<!-- sdk-boundary:end -->

The declared host bindings mean the SDK facade, as shipped, resolves those
symbols against this application. A third party reimplementing a host would
provide their own implementations behind the same Apache-licensed interface.
Extension authors are unaffected — the modules *they* import are Apache-2.0.

Two further bindings are made at runtime rather than by import:
`sdk/context-item.js` calls the host-installed `globalThis.__hostToolInvoker`
(`js/services/tool-invoker.js`) from `createToolInvoker`, and
`sdk/lib/sandbox-runner.js` calls `globalThis.__hostSandboxDelegate`
(`js/engine-worker-sandbox.js`, `js/engine-sandbox-node.mjs`).

**Type-only references**: JSDoc `@type {import('../js/…')}` annotations in
Apache files reference host types for type-checking. They are comments, create
no runtime dependency, and are erased by any bundler.

The reverse direction — the AGPL app importing from the Apache SDK — is
unrestricted and common (the app uses its own SDK).

## Vendored third-party code

`web/js/vendor/` holds third-party libraries copied into the repository verbatim
(PDF.js, marked, Yjs, Prism). They keep their own upstream licences — all
permissive (Apache-2.0 or MIT) — and each is recorded with its version, source
and licence in [`web/js/vendor/README.md`](web/js/vendor/README.md). Apache-2.0
code sitting inside the AGPL tree is compatible in that direction; it is stated
here rather than left implied.

## Official binaries and the pro tier

Official Juggler binaries are built and distributed from a separate private
repository. They may bundle additional proprietary components (paid features)
alongside the open code in this repository. The licenses above apply to this
repository's contents wherever they appear; proprietary add-ons are separate
works layered on the extension seams, not modifications of the AGPL code.

If you want to use Juggler's AGPL code in a way the AGPL doesn't permit,
contact the author about commercial licensing.

## Contributions and inbound rights

A contribution is publicly licensed under the license of the directory it lands
in: Apache-2.0 for `web/sdk/**` and `web/extensions/**`, and
AGPL-3.0-or-later elsewhere.

Outside contributors must also sign [Juggler’s ICLA](CLA.md), and companies that
may own contributed work must execute the [CCLA](CCLA.md). Contributors retain
copyright. The agreements give Julian Storer and a qualifying successor the
rights needed to distribute contributions under the applicable open-source
license and under commercial or proprietary terms. They also commit that a
contribution included in this public Project will remain available under the
open-source license that covered its destination when submitted. Proprietary
licensing does not withdraw or replace that public license.

Every commit also requires a `Signed-off-by:` line certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). The
DCO certifies provenance and permission to submit under the indicated
open-source license; it does not replace the additional rights granted by the
contributor agreements. See
[`CONTRIBUTING.md`](CONTRIBUTING.md#licensing-and-contributor-agreements) for the
complete process.
