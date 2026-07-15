# Headless Juggler server. See docs/headless-linux.md.
#
# Build:  place a Linux `juggler` binary next to this Dockerfile (from the
#         release tarball, or your own build), then
#           docker build -t juggler .
# Run:    docker run -it -p 3939:3939 -v "$PWD:/work" -w /work juggler
#
# The server runs its agent engine inside a hidden WebKitGTK webview, so the
# image carries the GTK4/WebKitGTK runtime and starts under Xvfb (a virtual
# display). `--public` makes the mapped port reachable from outside the
# container — the container boundary replaces the usual localhost-only default,
# so only publish the port on networks you trust.

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgtk-4-1 libwebkitgtk-6.0-4 xvfb xauth \
        ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# WebKit's bubblewrap sandbox cannot nest inside the container's own sandbox;
# disabling it here is the standard containerised-WebKit configuration.
ENV WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1

COPY juggler /usr/local/bin/juggler

EXPOSE 3939

ENTRYPOINT ["xvfb-run", "-a", "/usr/local/bin/juggler"]
CMD ["--public"]
