# Headless Juggler server. See docs/headless-linux.md.
#
# Build:  place a Linux `juggler` binary next to this Dockerfile (from the
#         release tarball, or your own build), then
#           docker build -t juggler .
# Run:    docker run -it -p 3939:3939 -v "$PWD:/work" -w /work juggler
#
# The server runs its agent engine in a Node.js child process, so the image
# carries a Node runtime and needs no display: no Xvfb, no X or Wayland server.
# It still installs the GTK4/WebKitGTK runtime, because the server binary lists
# those libraries in DT_NEEDED and the dynamic loader resolves them at exec
# whichever host the engine ends up running in. `serve --lan` turns on LAN
# access, which the mapped port needs: a connection through it arrives from
# outside the container. The container boundary replaces the usual
# localhost-only default, so only publish the port on networks you trust.

FROM ubuntu:24.04

# libgtk-4-1 and libwebkitgtk-6.0-4 satisfy the binary's link-time dependencies
# (they pull in libX11, libsoup and libjavascriptcoregtk with them); without
# them the server dies at startup with "error while loading shared libraries".
# git is what the agent shells out to; curl and xz-utils unpack Node below.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgtk-4-1 libwebkitgtk-6.0-4 \
        ca-certificates curl git xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node.js from the official tarball, pinned to one version and checksum. Ubuntu
# 24.04 packages Node 18, below the engine host's floor of 22; a pinned tarball
# also rebuilds identically, which an apt repo tracking a moving 24.x does not.
# Node 24 is the active LTS line. The floor that matters in practice is 22.7,
# the first release to detect module syntax without a flag — the engine snapshot
# is ES modules in .js files with no package.json beside them.
ENV NODE_VERSION=24.19.0

RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) arch=x64; sha=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647 ;; \
        arm64) arch=arm64; sha=01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc ;; \
        *) echo "no Node build pinned for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    tarball="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"; \
    echo "${sha}  ${tarball}" | sha256sum -c -; \
    tar -xJf "${tarball}" -C /usr/local --strip-components=1 --no-same-owner \
        --exclude CHANGELOG.md --exclude LICENSE --exclude README.md; \
    rm "${tarball}"; \
    node --version

# Pick the engine host explicitly. `auto` resolves to node here anyway, but on a
# failed probe it falls back to the webview, which has no display to open in
# this image — that reports a missing display rather than the missing Node that
# caused it. Override at run time with `docker run -e JUGGLER_ENGINE_HOST=auto`.
ENV JUGGLER_ENGINE_HOST=node

COPY juggler /usr/local/bin/juggler

EXPOSE 3939

ENTRYPOINT ["/usr/local/bin/juggler"]
CMD ["serve", "--lan"]
