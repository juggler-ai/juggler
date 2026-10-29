//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bufio"
	"cmp"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"sync"
)

// Bare juggler — `cd proj && juggler` — is sugar over the machine server.
// With no server running, this process is the server, in its terminal's
// foreground (Serve with a Foreground). With one running, it attaches to it
// and opens its project's session there (attachTo). Either way it prints the
// session's URL and runs until Ctrl-C.

// TerminalOptions is one run of bare juggler (RunTerminal).
type TerminalOptions struct {
	// Project is the folder to open a session for; "" opens none, pointing
	// the terminal at the sessions page instead.
	Project string
	// Port, AllowHosts and the developer flags (Dev, AssetsFromDisk; see
	// ServeOptions) apply when this run starts the server. Port 0 is
	// DefaultPort.
	Port                int
	AllowHosts          []string
	Dev, AssetsFromDisk bool
	// Assets is the web tree the sessions page is served from, and Peer what
	// answers a tunnel's WebRTC offers, when this run serves.
	Assets fs.FS
	Peer   Peer
	// Stdout is where the run says what it is doing, Stderr why it failed.
	Stdout, Stderr io.Writer
	// Stdin, when set, is a person at the terminal: b+Enter opens the session
	// in a browser, and a server of another version is offered a restart
	// rather than refused.
	Stdin io.Reader
	// OpenBrowser opens a URL in the default browser.
	OpenBrowser func(url string) error
	// Signals delivers Ctrl-C and the other requests to stop.
	Signals <-chan os.Signal
	// Ready, when set, is told the URL once the session is running.
	Ready func(url string)
}

// terminalAttempts is how many times a run finds the server gone before it has
// used it — lost a race for the lock, or caught a server on its way out — and
// tries again, before it gives up.
const terminalAttempts = connectStarts

// RunTerminal runs bare juggler and returns its exit code. It serves in the
// foreground when it can take the machine lock, and otherwise attaches to the
// server holding it. A server found on its way out, or one that loses the lock
// in the moment between, is followed by another try.
func RunTerminal(opts TerminalOptions) int {
	var in *bufio.Reader
	if opts.Stdin != nil {
		in = bufio.NewReader(opts.Stdin)
	}
	opts.Ready = withKeys(opts, in)
	for attempt := 0; attempt < terminalAttempts; attempt++ {
		err := Serve(ServeOptions{
			Port: cmp.Or(opts.Port, DefaultPort), Implicit: true, AllowHosts: opts.AllowHosts, Assets: opts.Assets, Peer: opts.Peer, Signals: opts.Signals,
			Dev: opts.Dev, AssetsFromDisk: opts.AssetsFromDisk,
			Foreground: &Foreground{Project: opts.Project, Out: opts.Stdout, Ready: opts.Ready},
		})
		var held *LockHeldError
		switch {
		case err == nil:
			return 0
		case errors.As(err, new(badAllowHostError)):
			fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
			return 2
		case !errors.As(err, &held):
			fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
			return 1
		}
		c, err := Connect(ConnectOptions{})
		if errors.Is(err, ErrNoServer) {
			continue
		}
		if err != nil {
			fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
			return 1
		}
		code, again := attachTo(c, opts, in)
		if !again {
			return code
		}
		if code == restarted {
			attempt = -1
		}
	}
	fmt.Fprintf(opts.Stderr, "juggler: the Juggler server kept stopping before it could be used (%d attempts); see %s\n", terminalAttempts, serveLogPath())
	return 1
}

// restarted is attachTo's code when it stopped a server of another version at
// the user's word: the run connects again with its attempts afresh.
const restarted = -1

// attachTo uses the server c reaches for opts.Project: it attaches, so the
// server counts this run as a client, opens the session, prints its URL, and
// waits for Ctrl-C or for the server to go. Ctrl-C releases its session and
// server holds. again reports a server that went before it could be
// used — gone, shutting down, or restarted at the user's word — for which the
// run connects again.
func attachTo(c *Client, opts TerminalOptions, in *bufio.Reader) (code int, again bool) {
	if c.Build != ownBuild() {
		return offerRestart(c, opts, in)
	}
	a, err := c.Attach()
	if err != nil {
		if ServerGoing(err) {
			return 0, true
		}
		fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
		return 1, false
	}
	page := "http://" + c.Addr() + "/"
	url := page
	var sess Session
	if opts.Project != "" {
		sess, _, err = c.OpenSession(opts.Project)
		if err != nil {
			a.Close()
			if ServerGoing(err) {
				return 0, true
			}
			fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
			return 1, false
		}
		named, err := c.Attach(sess.ID)
		if err != nil {
			a.Close()
			if ServerGoing(err) {
				return 0, true
			}
			fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
			return 1, false
		}
		// Acquire the named hold before letting the initial server hold go:
		// the last local client leaving stops an implicit server immediately.
		a.Close()
		a = named
		url = c.SessionURL(sess.ID)
	}
	defer a.Close()
	// An attachment the server ended before the session was open is a
	// server that began its shutdown in between, and the session goes with
	// it.
	select {
	case <-a.Done():
		return 0, true
	default:
	}

	fmt.Fprintf(opts.Stdout, "Using the Juggler server at %s\n", page)
	if opts.Port != 0 || len(opts.AllowHosts) > 0 {
		fmt.Fprintln(opts.Stderr, "juggler: --port and --allow-host apply only when juggler starts the server; it was already running.")
	}
	if opts.Project == "" {
		fmt.Fprintln(opts.Stdout, "Open a project from its page.")
		fmt.Fprintln(opts.Stdout, "Ctrl-C detaches from the server.")
	} else {
		fmt.Fprintf(opts.Stdout, "Session for %s: %s\n", opts.Project, url)
		fmt.Fprintln(opts.Stdout, "Ctrl-C detaches from this session.")
	}
	if c.Implicit {
		fmt.Fprintln(opts.Stdout, "If this is the last local client, Ctrl-C stops the server and every session on it.")
	}
	if opts.Ready != nil {
		opts.Ready(url)
	}

	select {
	case <-a.Done():
		fmt.Fprintf(opts.Stdout, "The Juggler server at %s has stopped.\n", page)
		return 0, false
	case <-opts.Signals:
	}
	if opts.Project != "" {
		fmt.Fprintf(opts.Stdout, "Detached from the session for %s.\n", opts.Project)
	}
	a.Close()
	if c.Implicit {
		fmt.Fprintln(opts.Stdout, "Detached. If this was the last local client, the server and every session stop with it.")
	}
	return 0, false
}

// offerRestart answers a server that is another build than this binary
// (BuildOf) — another version, or another build of this one — which a run
// never uses. One that is idle (Occupancy.Idle) is replaced without asking,
// and the run connects again, on an ordinary attempt, to start a server of its
// own build. Any other is the user's: a person at the terminal (in) is told
// what a restart would stop and asked, and a yes stops it — unless it has come
// to hold more meanwhile, when they are asked again — and the run connects
// again with its attempts afresh. Otherwise the run is refused with the way
// out.
func offerRestart(c *Client, opts TerminalOptions, in *bufio.Reader) (code int, again bool) {
	failed := func(err error) (int, bool) {
		if ServerGoing(err) {
			return 0, true
		}
		fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
		return 1, false
	}
	replaced, occ, err := c.ReplaceIfIdle()
	switch {
	case err != nil:
		return failed(err)
	case replaced:
		fmt.Fprintf(opts.Stdout, "Restarted the idle Juggler server (%s) as %s.\n", c.Build, ownBuild())
		return 0, true
	}
	for in != nil {
		fmt.Fprintf(opts.Stdout, "The Juggler server running here is %s; this is %s.\nRestarting it stops:\n%sRestart it? [y/N]: ",
			c.Build, ownBuild(), describeStops(occ))
		answer, _ := in.ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
			break
		}
		var busy *OccupiedError
		err := c.RestartAsAgreed(occ)
		if errors.As(err, &busy) {
			fmt.Fprintln(opts.Stdout, "It is in use beyond that now, so it was not stopped.")
			occ = busy.Now
			continue
		}
		if err != nil {
			return failed(err)
		}
		return restarted, true
	}
	fmt.Fprintf(opts.Stderr, "juggler: the Juggler server running here is %s; this is %s. "+
		"Stop it with `juggler server stop`, then run juggler again. That stops:\n%s",
		c.Build, ownBuild(), describeStops(occ))
	return 1, false
}

// describeStops is what a restart would stop (Occupancy.Stops), in English,
// one item a line, for a terminal.
func describeStops(o Occupancy) string {
	var b strings.Builder
	for _, m := range o.Stops() {
		fmt.Fprintf(&b, "  - %s\n", strings.ReplaceAll(m.English(), "\n", "\n      "))
	}
	return b.String()
}

// withKeys returns the Ready a run hands on: opts.Ready, and for a person at
// the terminal who has a browser, b+Enter opening the session's URL. The keys
// are read from in, which the restart offer shares, once a session is ready;
// a run that connects again is ready again, at the URL it holds then.
func withKeys(opts TerminalOptions, in *bufio.Reader) func(url string) {
	if in == nil || opts.OpenBrowser == nil {
		return opts.Ready
	}
	urls := make(chan string, 1)
	var reading sync.Once
	return func(url string) {
		fmt.Fprintln(opts.Stdout, "Type 'b' + Enter to open it in your browser.")
		select {
		case <-urls:
		default:
		}
		urls <- url
		reading.Do(func() { go readKeys(in, urls, opts) })
		if opts.Ready != nil {
			opts.Ready(url)
		}
	}
}

// readKeys opens the latest ready URL in the browser for each b+Enter, until
// in ends.
func readKeys(in *bufio.Reader, urls chan string, opts TerminalOptions) {
	var url string
	for {
		line, err := in.ReadString('\n')
		select {
		case url = <-urls:
		default:
		}
		if strings.EqualFold(strings.TrimSpace(line), "b") && url != "" {
			if err := opts.OpenBrowser(url); err != nil {
				fmt.Fprintf(opts.Stderr, "juggler: could not open a browser: %v\n", err)
			}
		}
		if err != nil {
			return
		}
	}
}
