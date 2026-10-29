# Security

Juggler is a local AI coding agent that runs as a web server on your machine.
This document describes its trust model and how to report vulnerabilities.

## Trust model

### Default (localhost-only)

Juggler runs one server per machine (`juggler serve`, which the desktop app
and `juggler` in a terminal start on demand). It binds to all interfaces, but
a LAN gate rejects any request from a non-loopback IP with 403 **by default,
every time the server starts** unless you have chosen otherwise (below). Out of
the box nothing off your machine can reach it. Each project's session runs in a
child process that listens on loopback alone; callers from elsewhere reach it
only through the server. The browser UI is served to you as the machine's only
user; there is no login. That is the trust assumption: the sessions page, at
the server's root, hands its control token to anything on this machine that
loads it, so any process on the machine — under your account or another one —
can connect and drive the agent as you. Don't run Juggler on a machine you
share with users you don't trust.

### LAN access (opt-in, no authentication)

LAN exposure is never a silent default. You turn it on explicitly — Start LAN
access on the sessions page or in a session's Settings → Connectivity,
`juggler server lan on`, or
`juggler serve --lan` —
after deciding the network is trusted. Only this machine can turn it on or off,
or stop the server. A server starts with it off unless you have ticked "Start
whenever Juggler starts" for it on the sessions page or in Settings →
Connectivity (saved as
`connectivity.lanOnLaunch` in `~/.juggler/settings.json`), which then applies
to every start of the server, from the desktop app or a terminal. Only a viewer
on this machine can change that choice. Once on, the LAN gate accepts connections from non-loopback
addresses on the same network, and the sessions page and Settings →
Connectivity show each address with a scannable QR code.

In LAN mode:

- **Any device on the network can use the agent.** There is no password, and
  the address is no secret: it is this machine's IP and port (3939 by
  default), which any device on the network can find. Anyone who reaches it
  can list, open, run and stop sessions, open new ones in any folder your user
  can read, and create folders. LAN access is machine-wide: it exposes every
  session on the machine, not one project.
- A LAN caller is always a **remote** viewer: it cannot take the in-process
  engine slot, rearrange this machine's windows (a session's stored UI
  preferences), switch LAN access, tunnels or what opens at start, or stop the
  server. Everything else a session offers it can use as you can, settings
  included: it can change your global settings and provider configuration,
  and the allowed host names (below), which take effect at the server's next
  start.
- The WebSocket upgrader rejects connections whose `Origin` header does not
  match the request `Host`. This stops a different web page the user (or a
  LAN peer) is browsing from opening a socket and silently driving the
  agent. Browser clients that omit `Origin` (or non-browser clients) are
  still allowed; the LAN gate is the primary access control.
- Shell execution, file writes, and other side-effecting tools go through the
  **UI approval flow** (see "Shell execution" below for what runs without a
  prompt). A prompt waits for a click in a connected window or browser, and
  every connected client sees and can answer it — so anyone you give the URL
  to can approve tool calls.

### Behind a reverse proxy (opt-in, by name)

The server refuses requests whose `Host` is a public DNS name. That stops
DNS rebinding, where a page on a domain the attacker controls points that
domain at your machine. A reverse proxy on the same machine, such as
`tailscale serve` or caddy, forwards its own public name as `Host`, so you
name it explicitly: `--allow-host <name>` (repeatable), or
`connectivity.allowedHosts` in `~/.juggler/settings.json`. Only exact names
are accepted, never wildcards. Name only a host whose DNS you control.

The proxy connects over loopback, but a request arriving that way under an
allowed name is treated as a **remote** viewer, with a LAN caller's limits
(above). Like any caller, it is handed the control token with the sessions
page and a session's API token with that session's page: the tokens stop
drive-by pages, not someone who can reach the proxy. LAN access is still
opt-in: the name only lets requests through the proxy itself, not a LAN client
that sends it. Anyone who can reach the proxy can drive the agent, so its
access control (your tailnet, for example) is the access control.

### WAN access (not in this build)

A build from this repository has no built-in WAN (internet) exposure mechanism
— its reach is localhost and, when you opt in, your LAN. The machine server does
expose a tunnel-mode registry seam through which a wrapping distribution can
register WAN transports (the official binaries do). A tunnel is opened only from
this machine, one at a time. None is open when the server starts unless
`--tunnel` names one, or a mode is saved to start with it
(`connectivity.wanOnLaunch`, chosen from this machine only). Like LAN access, a
tunnel has no password: its link is the grant, and anyone who has it can use
every session on the machine, so share it as you would a password. Anything
arriving through one is subject to the same invariants this codebase enforces
for every remote caller: it is tagged as remote ingress, admitted only while
that tunnel is open, reaches sessions only as a viewer, and is refused the
in-process engine WebSocket role, switching LAN access, tunnels or what opens
at start, reading the tunnel's link, and stopping the server — a remote client
can never claim the engine slot, even though such traffic reaches a session
over loopback. Closing the tunnel ends its connections. The trust properties of
any specific WAN mode are documented by the distribution that ships it.

### Connecting the desktop app to another server

Session ▸ Connect to Server… points a desktop window at another machine's
server by URL. That server then supplies everything the window shows and sees
everything you do in it, and its commands run on that machine, not yours. What
its pages may ask of the desktop app is limited to their own window: its
title, colour and window controls, moving between that server's sessions and
its sessions page, opening a board window on the same server, opening http and
https links in your browser, and offering a download through the Save dialog.
They are refused the app's language and zoom, file and folder pickers and
dropped folders (which would reveal local paths), the updater, connecting
elsewhere, quitting, and restarting this machine's server. Connect only to
servers you trust.

### Sessions share one origin (by design)

Every session's UI is served from the server's own address, under
`/s/<id>/`, and the sessions page at `/` carries the server's control token
for whoever may load it — on the LAN, through a proxy or a tunnel too. To the
browser they are all one origin. So script
running in any session's page — for example an extension you installed in
`~/.juggler/extensions` — can read the sessions page and other sessions'
pages and act through them: list, open and stop sessions, and use the control
API. In a page opened on this machine that includes switching LAN access and
tunnels; in a page opened from elsewhere it does not.

This is no wider than what such script already has. A session's page holds
that session's API token, which runs tools as your user, and a session opened
on this machine can already switch LAN access and tunnels from Settings →
Connectivity. Trust an extension as you would any program you run. HTML file
previews (and any project file opened from its URL), and the frame that runs
untrusted JavaScript for the agent, load sandboxed without same-origin access,
so they do not share the origin. A preview can still read the session token in
its own URL and carry it off in a URL it loads an image or script from.

## What the agent can do

The agent can read and write files in the project directory and below (outside
it only with your approval or under a folder you granted the conversation);
spawn shell subprocesses with the privileges of the user running Juggler; and
call out to whichever LLM providers you have configured credentials for.

### Out-of-project file reads

When you @-mention an absolute path in the browser UI (e.g.
`@/etc/hosts`), the `userInitiated=true` flag is passed to the file-read
operation and the read is permitted even though the path is outside the
project directory. **This is by design** — it lets you point the agent at
config files and other context — but it does mean an LLM acting on your
behalf can be steered toward arbitrary readable files via a crafted
@-mention. Every such read is logged at INFO level for audit. The LLM
itself cannot set the flag: its own file tools read outside the project only
with your approval for that read or under a folder you granted, and a shell
command (below) is not confined to the project at all.

### Shell execution

Shell commands run with the full privileges of the user running Juggler. The
server contains a tiny "obvious foot-gun" filter (`bestEffortShellSanityCheck`
in `cmd/juggler/ops/shell_command_parse.go`) that rejects a hard-coded list of
patterns like `rm -rf /`. **This is not a security control** — it is trivial
to bypass and exists only to catch accidental destructive copy-pastes. The
real safety net is the UI approval modal: with the default strategy, a shell
tool call waits for you to click approve unless it is a command the built-in
analyser recognises as read-only and confined to the project (or a folder you
granted), or a rule or setting you saved allows it. The YOLO
strategy approves without asking, the Auto-approve strategy lets a reviewing
model decide, and `juggler run` uses YOLO unless told otherwise. A hook file in
`~/.juggler/hooks/` can deny or ask about a command but never allow one; an
extension's hook can allow one.

### Changing the server's exposure (by design)

The agent can do anything your user can do on this machine, and widening the
server's network exposure is one of those things. The server lets any caller
on this machine turn LAN access or a tunnel on, choose what opens when it
starts, and shut it down, provided it presents the control token. That token
is in `~/.juggler/server.json`, readable only by your user — which includes
every command the agent runs — and in the sessions page the server hands any
caller on this machine. So an agent turn, for example one steered by a
prompt injection in content it reads, can turn on LAN access or a tunnel,
exposing every session on the machine, and read back the link.

What stands in the way:

- **Approval.** With the default strategy, a shell command that reads that
  file or calls the server waits for your approval unless a rule you saved
  allows it. The YOLO strategy approves such commands without asking, the
  Auto-approve strategy lets a reviewing model approve them, and a broad
  saved rule allows them outright. A hook in `~/.juggler/hooks/` can deny or ask about
  matching commands. The agent's web fetch and search tools refuse loopback
  and private addresses, so they cannot reach the server.
- **The header's network button** shows how many other clients are connected
  to the session you are viewing. It does not show whether LAN access or a
  tunnel is on, or who is connected to other sessions. Whether LAN access
  or a tunnel is on is shown in Settings → Connectivity and, on this
  machine, on the sessions page.
- **Isolation.** Run untrusted material — repositories, documents, web
  content you point the agent at — in a sandboxed environment (a container
  or VM). A separate user account on the same machine is not enough: as
  above, any account on the machine can drive the agent as you.

### Credentials

Provider API keys live in `~/.juggler/credentials.json` (written with mode
0600). Juggler never logs credential values. Be aware that any tool the
agent runs (a shell command, a file read) can see your environment and home
directory, including these credentials.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

- Email: info@juggler.studio

Include a description, reproduction steps, and an indication of impact. We'll
acknowledge within a few days and coordinate a fix and disclosure timeline
with you.

## Supported versions

Only `main` is supported. There is no LTS or backport policy.
