//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"juggler/cmd/juggler/core"
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
	// Port and AllowHosts apply when this run starts the server.
	Port       int
	AllowHosts []string
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
			Port: opts.Port, Implicit: true, AllowHosts: opts.AllowHosts, Signals: opts.Signals,
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
		if errors.Is(err, errNoServer) {
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
// waits for Ctrl-C or for the server to go. Ctrl-C stops the session only if
// this run opened it. again reports a server that went before it could be
// used — gone, shutting down, or restarted at the user's word — for which the
// run connects again.
func attachTo(c *Client, opts TerminalOptions, in *bufio.Reader) (code int, again bool) {
	if c.Version != core.Version {
		return offerRestart(c, opts, in)
	}
	a, err := c.Attach()
	if err != nil {
		if serverGoing(err) {
			return 0, true
		}
		fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
		return 1, false
	}
	page := "http://" + c.Addr() + "/"
	url := page
	var sess Session
	var opened bool
	if opts.Project != "" {
		sess, opened, err = c.OpenSession(opts.Project)
		if err != nil {
			a.Close()
			if serverGoing(err) {
				return 0, true
			}
			fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
			return 1, false
		}
		url = c.SessionURL(sess.ID)
	}
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
	switch {
	case opts.Project == "":
		fmt.Fprintln(opts.Stdout, "Open a project from its page.")
		fmt.Fprintln(opts.Stdout, "Ctrl-C leaves the server running.")
	case opened:
		fmt.Fprintf(opts.Stdout, "Session for %s: %s\n", opts.Project, url)
		fmt.Fprintln(opts.Stdout, "Ctrl-C stops this session.")
	default:
		fmt.Fprintf(opts.Stdout, "Session for %s: %s\n", opts.Project, url)
		fmt.Fprintln(opts.Stdout, "Ctrl-C leaves this session running, since it was already open.")
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
	if opened {
		if err := c.StopSession(sess.ID); err != nil && !serverGoing(err) {
			fmt.Fprintf(opts.Stderr, "juggler: stop the session for %s: %v\n", opts.Project, err)
			a.Close()
			return 1, false
		}
		fmt.Fprintf(opts.Stdout, "Stopped the session for %s.\n", opts.Project)
	} else if opts.Project != "" {
		fmt.Fprintf(opts.Stdout, "Left the session for %s running.\n", opts.Project)
	}
	a.Close()
	return 0, false
}

// offerRestart answers a server running another version than this binary,
// which a run never uses. A person at the terminal (in) is offered a restart:
// yes stops the server, and once it has gone the run connects again — to
// start a server of its own version. Otherwise the run is refused with the
// way out.
func offerRestart(c *Client, opts TerminalOptions, in *bufio.Reader) (code int, again bool) {
	var st statusResponse
	if err := c.do(http.MethodGet, "/status", nil, &st); err != nil {
		if serverGoing(err) {
			return 0, true
		}
		fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
		return 1, false
	}
	sessions := fmt.Sprintf("%d sessions", st.Sessions)
	if st.Sessions == 1 {
		sessions = "1 session"
	}
	refuse := func() (int, bool) {
		fmt.Fprintf(opts.Stderr, "juggler: the Juggler server running here is %s; this is %s. "+
			"Stop it with `juggler server stop` (that stops its %s), then run juggler again.\n",
			c.Version, core.Version, sessions)
		return 1, false
	}
	if in == nil {
		return refuse()
	}
	fmt.Fprintf(opts.Stdout, "The Juggler server running here is %s; this is %s.\nRestart it? This stops its %s. [y/N]: ",
		c.Version, core.Version, sessions)
	answer, _ := in.ReadString('\n')
	if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
		return refuse()
	}
	if err := c.do(http.MethodPost, "/shutdown", nil, nil); err != nil && !serverGoing(err) {
		fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
		return 1, false
	}
	if err := c.awaitGone(); err != nil {
		fmt.Fprintf(opts.Stderr, "juggler: %v\n", err)
		return 1, false
	}
	return restarted, true
}

// awaitGone returns once the server c reaches has stopped answering, after a
// shutdown it was asked for. It follows the server's progress: it stops
// answering as soon as its drain begins. connectTimeout bounds only a server
// that never does.
func (c *Client) awaitGone() error {
	deadline := time.Now().Add(connectTimeout)
	for {
		if err := c.do(http.MethodGet, "/status", nil, nil); err != nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the Juggler server at %s did not stop within %s", c.addr, connectTimeout)
		}
		time.Sleep(connectPoll)
	}
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
