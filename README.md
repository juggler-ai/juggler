# Juggler

Yes, it's another AI coding agent. The industry definitely needed one more.

If Juggler has an angle, it's that it's for people who want to be more hands-on over what the LLM is doing to their codebase. It gives you a visual workbench: inspectable tool calls, branching threads, editable context.

More blurb on the website: [https://juggler.studio](https://juggler.studio)

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-main.webp" alt="Juggler's Miller-column workbench: tool calls, item properties and nested sub-threads" width="880">
</p>
<p align="center"><em>Tool calls, item properties and nested sub-threads laid out in a Finder-style Miller column view.</em></p>

And here's the TL;DR:

- **It is a proper GUI.** This is not a console app. It's all about graphical visual navigation, inspection, and control.
- **The session is a tree, not a doom-scroll.** It's a Yjs document, not a transcript. Create sub-threads, drill down, backtrack, compare, and edit.
- **Sessions are persistent and stateful.** Because a session is a document on disk, you can quit or relaunch and it resumes every conversation exactly where you left it. That even includes states such as an agent waiting for user approval. You can restart, reconnect, and the approval dialog will be there waiting for you.
- **Everything is inspectable.** Tool calls, approvals, thread structure, item properties, raw context — laid out in Finder-style Miller columns for fast navigation.
- **It's plugins all the way down.** Context items, slash commands, LLM loop strategies, and their UIs are JavaScript extensions you can inspect, fork, or replace.
- **It runs locally, remotely, or both at once.** Use the same session with the same UI in the native desktop app, and/or browsers. Multiple clients can attach to the same session.
- **It talks to the usual model zoo.** Claude Code (via CLI or API), OpenAI (codex plan or API), Gemini, Ollama, OpenRouter, Z.AI, Deepseek, etc.

----------

## Getting started

Download a build from the [Releases](https://github.com/juggler-ai/juggler/releases) page or via [juggler.studio](https://juggler.studio).

Each download contains the same two moving parts:

- **Juggler app** — the native desktop app. Works like you'd expect it to.
- **`juggler`** — the headless command-line server. Run this from a terminal for long-lived, remote, or network-accessible sessions. It has no window of its own, but you can type `w` into its terminal to open the desktop app, or use the browser URL it prints.

The desktop app, browser tabs (on local or remote machines) can all be clients viewing the same server session.

#### Installing

- **macOS** — download the `.dmg`, open it, and drag Juggler to Applications, then launch it. The app and its server are bundled together, so the server starts automatically. The first time you open it, macOS Gatekeeper may block the download: right-click (or Control-click) the app → **Open** → **Open**, or go to **System Settings → Privacy & Security → Open Anyway**. After the first launch it opens normally.
- **Windows** — download `Juggler-<version>-setup.exe` and run it. It installs the desktop app and the matching `juggler.exe` command-line server together in one directory (and can add `juggler` to your PATH), so the two never drift apart.
- **Linux** — download the `juggler` server binary and run it from a terminal, then connect with a browser or the desktop app. For servers, containers, and CI machines with no display, see [`docs/headless-linux.md`](docs/headless-linux.md).

The desktop app and the server always ship and install as one unit — see [`docs/distribution.md`](docs/distribution.md).

#### Running the server directly

For a headless session, just run:

```bash
juggler     # prints everything you need to connect from a browser
```

By default, the server opens a web UI and prints its URL plus a QR code for easy connection.

The server is localhost-only by default — nothing off your machine can reach it. To let other devices on your network connect, press `p` in the terminal (or launch with `--public`). LAN access has no password: anyone who can reach the address can drive the agent, so only enable it on networks you trust.

Access from beyond your LAN isn't built into this repository: a build from this source is local + LAN only. The official Juggler binaries from [juggler.studio](https://juggler.studio) additionally include WAN access modes for reaching your server across the internet (see [LICENSING.md](LICENSING.md) on components not in this repo).

----------

## What makes it different?

#### Your conversation is an editable tree, not a chat history

Most agents give you a single linear transcript and if you're lucky you can rewind it.

Juggler gives you a **tree**. Any point can branch into a sub-thread. Sub-threads can branch again. You can navigate, inspect, and edit the structure directly.

The UI uses **Miller columns**: root on the left, selected items expanding into properties and children to the right. (If you've used Finder's column view, you already understand the basic move).

#### Your session survives being closed — approvals and all

Because the whole session is a document, and the server is a state machine that modifies it, nothing is lost when you close the app. Quit, relaunch, lose the connection, come back tomorrow — it rehydrates exactly where it was.

Crucially, that includes workflow that's *waiting on you*. When the agent pauses for user intervention — to run a command, apply an edit, take the next step — that paused state is part of the document. You can shut everything down, reopen it later on the same machine or a different one, and the agent is still parked at the same decision, ready to resume the moment you say yes.

#### Everything is an extension

The core app manages the document and orchestration. Almost all the objects that make up the document are defined by JavaScript extensions:

- **Context items** — every item type in a conversation (`read-file`, `replace-text`, `bash`, …) controls both how it talks to the LLM and how it appears in the UI.
- **Strategies** — high-level LLM loops such as `plan`, `research`, or your own fever-dream inventions are plugins too.
- **Commands** — slash commands like `/clear` and `/compact` are all just plugins that manipulate the session document.

Not every LLM workflow wants to live as a headless Python script skulking in a terminal. If an orchestration idea needs its own UI, controls, or visualisation, Juggler is a platform for that.

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-extensions.webp" alt="Juggler's LLM-facing tools defined as extensions" width="760">
</p>
<p align="center"><em>Everything's a plugin — even the read/write/bash tools are defined in extensions you can inspect, fork, or replace.</em></p>

#### A desktop app with a multi-client architecture

Juggler looks like a native desktop app, but underneath it is a local webserver serving a live collaborative session. The app is just one client. A browser tab can be another. A different machine can be another.

That means you can run the server where the code lives — local workstation, dev box, server farm - and attach views from wherever is convenient.

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-browser.webp" alt="One Juggler session with multiple synced clients" width="760">
</p>
<p align="center"><em>One session, many clients — the desktop app and browser views stay in sync.</em></p>

<p align="center">
  <img src="https://juggler.studio/assets/screenshot-large.webp" alt="Juggler on a large desktop screen" width="600">
  <img src="https://juggler.studio/assets/screenshot-mobile.webp" alt="Juggler in a phone browser" width="170">
</p>
<p align="center"><em>Big screen or pocket-sized: the same live session, whether it's the desktop app or a remote browser on your phone.</em></p>

#### Model support

Juggler connects to the usual suspects: Claude Code (via CLI or API), OpenAI (codex plan or API), Gemini, Ollama, OpenRouter, Z.AI, Deepseek, etc. It's easy to add more providers, so if yours is missing, ask your friendly neighbourhood LLM to add it as a PR.

How Juggler keeps every request inside the model's context window — limits, admission, and automatic history recovery: [`docs/context-window.md`](docs/context-window.md).

----------

## Building from source

The idea with the extensions system is that most people won't need to actually build the app. If you do, see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full setup. The short version:

```bash
git clone --recurse-submodules https://github.com/juggler-ai/juggler.git
cd juggler && make build
```

If you already cloned without `--recurse-submodules`, fetch them with:

```bash
git submodule update --init --recursive
```

Windows binaries cross-compile from any host with `make build-windows`; the Linux desktop app must be built natively. If you want to build for a `x86/amd64` Intel Mac, you can build that locally.

## Tech stack

Juggler is a simple native app without baggage. The backend is Go, using Wails for windowing. The UI is HTML/JS served by the Go backend. Session documents are stored and synchronised with Yjs. Extensions are JavaScript. It doesn't use electron.

The frontend is type-checked JavaScript rather than TypeScript: types live in JSDoc and are enforced in CI with strict static linting. There's no build step between source and what ships.

----------

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, test commands, and project conventions. For security issues, please use the private channel described in [`SECURITY.md`](SECURITY.md) rather than the public issue tracker.

## License

Juggler's application code is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). The extension SDK (`web/sdk/`) and the bundled extensions (`web/extensions/`) are licensed under [Apache-2.0](web/sdk/LICENSE), so you can build extensions — including closed-source ones — with no copyleft obligation. See [`LICENSING.md`](LICENSING.md) for the full map.

For the AGPL parts you're free to use, modify, and redistribute — but any modified version you distribute or host as a service must also be released under the AGPLv3. If you want to do something closed-source with it, contact me to discuss commercial licensing.
