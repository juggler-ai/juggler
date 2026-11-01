# Proxies, certificates and endpoints

Juggler's own connections — to model providers, remote MCP servers, the web
tools and the update check — share one proxy policy. This page covers routing
them through a proxy, trusting a proxy's certificate authority, and pointing
the Codex provider at another endpoint. Together these are what it takes to run
Juggler behind a TLS-intercepting or credential-injecting proxy, such as the
one in a [nono](https://nono.sh/) sandbox.

## Where these variables go

Every variable on this page is read by Juggler itself, so it has to be in the
environment Juggler starts with. The `env.json` files in
[project-env.md](./project-env.md) do not work for this: they reach the
commands Juggler runs, not Juggler.

- **Terminal or service:** export the variables before starting `juggler`, or
  set them in the unit or container that starts it.
- **macOS app opened from the Dock or Finder:** it does not read your shell
  profile, so a variable exported in `~/.zshrc` never reaches it. Set it with
  `launchctl setenv NAME value` (lasts until you log out), then start Juggler.
- **Windows:** set it as a user environment variable, then start Juggler.

`SSL_CERT_FILE`, `SSL_CERT_DIR` and `JUGGLER_CODEX_BASE_URL` are read once,
when Juggler's server starts. After changing one, quit Juggler and start it
again.

## Routing through a proxy

**Settings → Connectivity → Outbound proxy** chooses the mode:

| Mode | Effect |
|---|---|
| System (recommended) | Uses `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` when they are set, then the operating system's proxy settings. Direct when neither is set. |
| Direct (no proxy) | Every connection goes direct; the variables and the system proxy are ignored. |
| Manual | Every connection goes through the URL you enter (`http://`, `https://` or `socks5://`). `NO_PROXY` still applies. |

Connections to `localhost` and loopback addresses always go direct, whatever
the mode, so local model servers stay reachable. A mode change applies to the
next request; there is no need to restart.

## Trusting a proxy's certificate authority

A proxy that intercepts TLS signs each connection with its own certificate
authority (CA), which your system does not trust, so Juggler's connections
through it fail with a certificate error. Point Juggler at that CA instead:

| Variable | Holds |
|---|---|
| `SSL_CERT_FILE` | One PEM file of CA certificates |
| `SSL_CERT_DIR` | Directories of PEM files, separated by `:` (`;` on Windows) |

What setting them does depends on the platform:

- **macOS and Windows:** setting either one **replaces** the system certificate
  store. Juggler then trusts only the certificates you name. Certificates added
  to the Keychain or the Windows store, such as a company's own CA, stop
  counting. If any connection reaches the internet without the proxy (a
  `NO_PROXY` host, for example), the file must hold the public roots as well.
  To get them, append the proxy's CA to a public bundle.
- **Linux:** `SSL_CERT_FILE` replaces the default CA bundle file and
  `SSL_CERT_DIR` replaces the default certificate directories. Whichever one you
  leave unset keeps its default.

Some tools set `SSL_CERT_FILE` in your shell profile for their own use; Homebrew,
conda and Python setups often do. A Juggler started from that shell on macOS or
Windows then trusts only that bundle. If this breaks connections, start Juggler
with `GODEBUG=x509sslcertoverrideplatform=0`: macOS and Windows then ignore both
variables and use the system store.

These variables cover Juggler's own connections. Programs Juggler starts, such
as the Claude Code CLI, stdio MCP servers and your commands, use their own TLS
libraries, and each decides which certificate variables to read. Node, for
example, reads `NODE_EXTRA_CA_CERTS`.

## Pointing Codex at another endpoint

The OpenAI Codex (ChatGPT plan) provider talks to
`https://chatgpt.com/backend-api/codex`. `JUGGLER_CODEX_BASE_URL` replaces it
for every Codex request: turns, the model list and usage:

```sh
JUGGLER_CODEX_BASE_URL='http://127.0.0.1:$CODEX_PROXY_PORT/backend-api/codex' juggler
```

- `$NAME` and `${NAME}` in the value are expanded from Juggler's environment,
  so it can name a port that is known only at runtime.
- It must be `https`, or `http` to `localhost` or a loopback address, because
  every request carries your Codex token. It must not include a user name,
  password, query or fragment. A trailing `/` is dropped.
- **A value that breaks these rules stops Codex.** Codex requests fail with an
  error naming the variable, and the reason is logged once. Juggler does not
  fall back to `chatgpt.com`, so your token never bypasses the endpoint you
  chose.

## Behind a credential-injecting proxy

A credential-injecting proxy keeps the real token out of Juggler. Juggler holds
a placeholder, and the proxy swaps in the real token on the way out.

- **Codex** reads its token from `~/.codex/auth.json` (or
  `$CODEX_HOME/auth.json`). Juggler checks the expiry only of a token it can
  read one from. A placeholder that is not a JWT is sent as it is, and the
  backend (here, the proxy) decides whether it is valid.
- **If the proxy intercepts TLS**, route Juggler through it (System mode with
  `HTTPS_PROXY`, or Manual) and set `SSL_CERT_FILE` to its CA.
- **If it serves a local endpoint instead**, set `JUGGLER_CODEX_BASE_URL` to
  that address. No CA is needed for an `http` loopback endpoint.
