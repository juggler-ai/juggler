# Juggler

**See and control your coding agent — locally or remotely.**

Juggler is a visual workbench for AI coding agents. Launch the desktop app and work locally; when the code is on a dev box or server, run Juggler there and open the same live session from the app or a browser.

Conversations are persistent trees rather than scrolling transcripts. Tool calls open into proper views, and every model transaction can be inspected to show what the model received and returned.

Juggler is vendor-neutral. Claude Code, OpenAI Codex, GitHub Copilot, Gemini, Ollama and other providers sit behind one interface, with no house model and no resold tokens: bring a subscription you already pay for or your own API keys. It is open source, free to download, and needs no account of its own.

Nothing sits between you and your provider. Prompts, code and keys go from your machine straight to whichever provider you chose — Juggler does not proxy that traffic, read it, or keep a copy anywhere but your own disk.

**[Download Juggler](https://github.com/juggler-ai/juggler/releases)** for macOS, Windows or Linux · [Visit the website](https://juggler.studio) · [Join the Discord](https://discord.gg/HyqZwKvSMd)

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-main.webp" alt="Juggler's Miller-column workbench showing tool calls, item properties and nested sub-threads" width="880">
</p>
<p align="center"><em>The session is a tree. Select anything to inspect it; branch whenever the work needs somewhere else to go.</em></p>

## Why Juggler?

Juggler is for developers who want the context, model calls and tool execution visible while an agent works.

- **Keep the agent where the code is.** Run Juggler on your workstation, a dev box or a server, then use the same live session from the desktop app or a browser. Several clients can stay connected at once.
- **Use a real desktop interface.** Miller columns make large sessions navigable, with tool calls, context and properties opening into their own views.
- **See what the model actually saw.** Open any recorded LLM transaction to inspect its system prompt, messages, tool definitions, output blocks, token use, cache use, stop reason and timing.
- **Operate on context.** Fold selected history into a thread, move or copy items between branches, edit the prompt identity and undo structural changes. Context is part of the workspace, not plumbing hidden behind the chat box.
- **Branch without polluting the main conversation.** Create nested threads for tangents, delegated research or competing approaches. A child thread does its work in isolation and returns the result to its parent.
- **Resume the session, not merely the chat log.** Conversations live on disk. Quit, reconnect or come back tomorrow and the document is still there, including approvals waiting for you.
- **Stay vendor-neutral.** Every provider is a plug-in: hosted APIs, agent CLIs you already have installed, or a local model through Ollama. Juggler sells no tokens and no credits, so it has no stake in which you pick — change provider or model mid-conversation and the session, context and tooling are unchanged.
- **Keep your code to yourself.** Model traffic goes direct from your machine to the provider you chose. Juggler puts no server in that path, inspects nothing that passes through it, and indexes no part of your repository into a cloud. Conversations and API keys stay on your own disk. The source is public, so none of that has to be taken on trust.

Juggler is built by [Julian Storer](https://github.com/julianstorer), the developer behind [JUCE](https://juce.com), [Tracktion](https://www.tracktion.com) and [Cmajor](https://cmajor.dev).

## Getting started

Download the latest build from [GitHub Releases](https://github.com/juggler-ai/juggler/releases) or [juggler.studio](https://juggler.studio).

Each download contains two parts that always ship together:

- **Juggler app** — the native desktop interface. Launch it and start working.
- **`juggler`** — the headless command-line server for long-lived, remote or network-accessible sessions. It has no window of its own, but you can type `w` in its terminal to open the desktop app or use the browser URL it prints.

The desktop app and browser tabs are clients of the same server, so several views can share one live session.

### Installing

- **macOS** — download the `.dmg`, open it and drag Juggler to Applications. On first launch, if Gatekeeper blocks it, right-click (or Control-click) the app → **Open** → **Open**, or use **System Settings → Privacy & Security → Open Anyway**.
- **Windows** — download `Juggler-<version>-setup.exe` and run it. The installer keeps the desktop app and matching `juggler.exe` server together, and can add `juggler` to your PATH.
- **Linux** — download the tarball for your architecture. It contains `juggler`, the terminal server, and `juggler-app`, the GTK desktop client. Run either from a terminal; for machines with no display, see [`docs/headless-linux.md`](docs/headless-linux.md).

See [`docs/distribution.md`](docs/distribution.md) for the complete app/server layout.

### Running the server directly

```bash
cd my-project && juggler
```

Juggler runs one server per machine, on port 3939 (or the next free one). `juggler` starts it in the terminal if none is running, opens a session for the current folder and prints its URL. Type `b` and press Enter to open it in your browser. The server's own page, at the root of that URL, lists every session and opens new ones in any folder. `juggler serve` runs the server alone, with no session of its own.

The server accepts connections from your machine only until you turn on LAN access: Start LAN access on the sessions page or in any session's Settings → Connectivity, `juggler server lan on`, or `juggler serve --lan`. It is off whenever the server starts, unless you tick "Start whenever Juggler starts" beside it. LAN access has no password, so turn it on only on networks you trust. While it is on, both show each address with a QR code for a phone; in a session's Settings → Connectivity the code opens that session.

To serve it through a reverse proxy on the same machine, such as `tailscale serve`, launch with `--allow-host <name>` for the name the proxy publishes. The flag is repeatable. Requests under that name count as remote viewers; see [SECURITY.md](SECURITY.md).

A build made from this repository supports local and LAN access. The official binaries from [juggler.studio](https://juggler.studio) also include WAN modes for reaching your server over the internet; see [LICENSING.md](LICENSING.md) for the boundary between this repository and those additional components.

----------

## Run it where the code lives

The server owns the session and runs on the machine that has the project. The desktop app and browsers are synchronised clients, so the interface can be wherever it is useful—another monitor, another computer or a phone. Several clients can share the same live session.

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-browser.webp" alt="One Juggler session open in multiple synchronised clients" width="760">
</p>
<p align="center"><em>One session, many clients.</em></p>

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-large.webp" alt="Juggler on a large desktop screen" width="600">
  <img src="https://juggler.studio/assets/screenshot-mobile.webp" alt="Juggler in a phone browser" width="170">
</p>

## The Context Surgeon

An agent's context should not be a sealed container.

Juggler represents the conversation as typed items inside a navigable tree. You can inspect the assembled system prompt and available tools, fold a section of history into a new thread, move or copy items, expand a branch back into its parent, and undo the operation if it was a bad idea. Delegated threads keep their intermediate work out of the parent context and return only the result requested.

The result is more deliberate than endlessly appending instructions to a transcript and hoping the model pays attention to the right bit.

## Every model transaction, opened up

Select **System Prompt** to inspect the prompt and tool inventory being assembled now. Select the token count on any completed turn to open the recorded transaction: input messages, system prompt, tool schemas, model output, usage, timing and stop reason.

This record helps separate an unexpected prompt, missing tool, stop condition or context limit from the model's own behaviour.

## Extensions, not a sealed product

Most capabilities that make up a Juggler conversation are JavaScript extensions using the same public SDK as the bundled ones:

- **Context items** define tools such as `read`, `write` and `bash`, including their model schema, execution and UI.
- **Strategies** define the LLM loop and which capabilities it can use.
- **Commands** add slash-command workflows.
- **Cards, Pinboard tabs and file viewers** add project-specific UI and visualisation.

MCP servers and skills enter through the same extension system. You can scaffold an extension from the CLI, link it into Juggler and see changes hot-reload without rebuilding the app. The SDK, bundled extensions and examples are Apache-2.0, so closed-source extensions are allowed without a copyleft obligation.

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-extensions.webp" alt="Juggler showing LLM-facing tools defined as extensions" width="760">
</p>

Start with [`docs/extension_tutorial.md`](docs/extension_tutorial.md), then use [`docs/extension_guide.md`](docs/extension_guide.md) as the reference.

## The MCP postman

If you build MCP tools, Juggler gives you somewhere to see what happened rather than infer it from the model's behaviour.

Point Juggler at a local or remote MCP server and its tools join the built-in toolset. You can follow the whole handoff—the schema offered to the model, the arguments it generated, the approval decision, and the result returned to the conversation. Juggler also lets you:

- see the tools and schemas offered to the model on the current turn;
- open a past model transaction to confirm exactly which tool definitions it received;
- inspect server status and logs, restart it, and see malformed schemas that were rejected;
- allow or deny individual tools, set fixed default arguments, and see their approximate context cost.

That makes Juggler useful not only as an MCP client, but as a workbench for testing and debugging MCP servers across different models. See [`docs/mcp.md`](docs/mcp.md) for configuration, transports and authentication.

## Model support

Juggler supports Anthropic and Claude Code, OpenAI and Codex, GitHub Copilot, Google Gemini, Mistral, Z.AI, Ollama, OpenRouter, DeepSeek and other OpenAI-compatible providers. Switch models and thinking levels without changing the rest of your workflow.

Juggler measures the complete request before each call, leaves room for the answer, and automatically compacts old history when a conversation outgrows the model's window. The full behaviour is documented in [`docs/context-window.md`](docs/context-window.md).

## Try it

**[Download the latest release](https://github.com/juggler-ai/juggler/releases)** for macOS, Windows or Linux. Open the app, choose a project and connect a model provider; no Juggler account is required.

Constructive feedback is welcome on [Discord](https://discord.gg/HyqZwKvSMd).

----------

## Building from source

Most customisation can be done through extensions without rebuilding Juggler. If you do need to build it, there is no frontend build step: Go compiles the binaries and embeds the HTML and JavaScript directly. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full development setup.

### Clone the repository

All platforms require Go 1.26+ and the vendored submodules:

```bash
git clone --recurse-submodules https://github.com/juggler-ai/juggler.git
cd juggler
```

If you already cloned without `--recurse-submodules`, run:

```bash
git submodule update --init --recursive
```

### macOS

Build the app and server:

```bash
make go-build
```

This creates `bin/Juggler.app`, with both binaries inside the bundle, and `bin/juggler` and `bin/juggler-app` symlinks pointing into it. Run the desktop app or headless server with:

```bash
open bin/Juggler.app
./bin/juggler
```

To create the same DMG layout used for official downloads, install `create-dmg` with `brew install create-dmg`, then run `make mac-dmg`. Locally built bundles are ad-hoc signed, so Gatekeeper will object if you move them to another machine.

The default build uses your Mac's architecture. An `x86/amd64` build for an Intel Mac can also be built locally.

### Linux

The server links GTK4 and WebKitGTK through cgo, so both the server and desktop app need their development packages at build time. On Ubuntu 24.04 or Debian:

```bash
sudo apt-get install -y libgtk-4-dev libwebkitgtk-6.0-dev libsoup-3.0-dev
```

Then build both binaries:

```bash
make go-build
```

This creates `bin/juggler` (the server) and `bin/juggler-app` (the desktop app). Run either with:

```bash
./bin/juggler
./bin/juggler-app
```

Linux desktop builds must be made natively on Linux. Use `make linux-tarball` to package the binaries in the same archive layout as the official download. For a host with no display, see [`docs/headless-linux.md`](docs/headless-linux.md).

### Windows

The supported environment is Git Bash with GNU make. Install those and Go with:

```bash
winget install Golang.Go
winget install Git.Git
winget install ezwinports.make
```

This is the combination used by CI. Avoid GnuWin32's make, which is still version 3.81 from 2006.

From Git Bash, build the native Windows binaries with:

```bash
make go-build
```

This creates `bin/juggler.exe` (the server) and `bin/juggler-app.exe` (the desktop app). To create the same installer layout as the official download, install Inno Setup and run `make win-installer`.

`make test` normally enables Go's race detector. If you do not have a C compiler installed, run it as `make test RACE=`.

For a quick build without installing make:

```bash
mkdir -p bin
go build -o bin/juggler.exe ./cmd/juggler
go build -ldflags "-H windowsgui" -o bin/juggler-app.exe ./cmd/juggler-app
```

The desktop app needs `-H windowsgui` or Windows opens a console window behind it. The server is a console binary on purpose: run from a terminal it stays in the foreground with visible output and Ctrl+C.

WSL2 also works, but it builds Linux binaries linked against GTK/WebKitGTK, not native Windows `.exe` files.

### Development commands

`make go-build` compiles the Go code without linting. `make test` runs the complete test suite. Before opening a PR, run `make test-full`, which runs the linters and tests; it requires Node and installs the JS/CSS toolchain into `tooling/` on first use. Run `make help` to list every target.

CI is a sanity gate for linting, builds and tests. It deliberately publishes no artifacts, so there are no per-commit builds to download; official release builds come from a separate pipeline.

## Tech stack

The backend is Go, using Wails for windowing. The UI is HTML and type-checked JavaScript served by the Go backend; there is no Electron shell or frontend compilation step. Session documents are stored and synchronised with Yjs. Extensions are JavaScript.

Frontend types live in JSDoc and are enforced in CI with strict static linting. The files in the repository are the files the app serves.

----------

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, test commands and project conventions. For security issues, use the private channel described in [`SECURITY.md`](SECURITY.md) rather than the public issue tracker.

## License

Juggler's application code is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). The extension SDK (`web/sdk/`), bundled extensions (`web/extensions/`) and examples (`examples/`) are licensed under Apache-2.0, so you can build extensions—including closed-source ones—with no copyleft obligation. See [`LICENSING.md`](LICENSING.md) for the full map and for additional components included in official builds.

For the AGPL parts, you are free to use, modify and redistribute the code, but a modified version distributed or hosted as a service must also be released under the AGPLv3. Contact the author to discuss commercial licensing for uses that require different terms.
