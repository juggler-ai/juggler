# Running Juggler headless on Linux

The `juggler` server is a terminal process with no window of its own — but it
is not display-free. It runs its agent engine inside a hidden WebKitGTK
webview, so even a "headless" server needs the WebKitGTK libraries and a
display server to start. On a desktop machine this all just works; on a truly
headless host — a container, a CI runner, a cloud VM over SSH — you supply a
virtual display instead.

The desktop app (`juggler-app`) always needs a real display. Headless setups
run only the server, and you connect to it from a browser (or the desktop app)
on another machine.

## 1. Install the runtime libraries

The server binary links GTK4 + WebKitGTK 6.0 and needs Xvfb (a virtual X
framebuffer). On Ubuntu 24.04+ / Debian:

```bash
sudo apt-get install -y libgtk-4-1 libwebkitgtk-6.0-4 xvfb
```

Equivalents elsewhere (names vary slightly by release):

| Distro family | Packages |
|---|---|
| Fedora / RHEL (dnf) | `gtk4 webkitgtk6.0 xorg-x11-server-Xvfb` |
| Arch (pacman) | `gtk4 webkitgtk-6.0 xorg-server-xvfb` |
| openSUSE (zypper) | `libgtk-4-1 libwebkitgtk-6_0-4 xvfb-run` |

If the WebKitGTK library is missing, the binary fails at the dynamic loader
with `error while loading shared libraries: libwebkitgtk-6.0.so…` — that error
always means "install the packages above".

## 2. Run it

```bash
juggler
```

That's it: when the server finds no `DISPLAY` or `WAYLAND_DISPLAY` and
`xvfb-run` is installed, it automatically relaunches itself under a virtual
framebuffer (`xvfb-run -a`). Set `JUGGLER_NO_XVFB=1` to disable the automatic
relaunch, or run the equivalent yourself:

```bash
xvfb-run -a juggler
```

The server prints its URL and a QR code. It is localhost-only by default —
press `p` in its terminal (or start with `--public`) to allow other devices on
your network to connect. The default port is 3939 (`--port` overrides).

## 3. If the webview still won't start

- **`bwrap: setting up uid map: Permission denied`** — the kernel is blocking
  the unprivileged user namespaces WebKit's sandbox needs (Ubuntu 23.10+
  restricts them via AppArmor by default). Juggler detects and works around
  the common cases automatically; if you still hit it, start with
  `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` — reasonable inside a container,
  which is itself a sandbox.
- **Rendering/GPU failures** on odd or virtual GL stacks: try
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1`.

## Docker

A known-good container recipe lives at
[`packaging/docker/Dockerfile`](../packaging/docker/Dockerfile). Place a Linux
`juggler` binary next to it (from the release tarball, or your own build),
then:

```bash
docker build -t juggler packaging/docker
docker run -it -p 3939:3939 -v "$PWD:/work" -w /work juggler
```

The image starts the server under Xvfb with `--public` (required for the
port mapping to be reachable; the container boundary takes the place of the
localhost-only default — don't publish the port beyond networks you trust).
