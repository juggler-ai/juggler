//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"text/tabwriter"
	"time"

	"juggler/internal/userpaths"
)

// The command line's view of the machine server: `juggler server
// status|sessions|stop|lan|tunnel` and `juggler open <project>`. Each finds the running
// server the way any client on this machine does (Connect) and drives the
// control API. None starts a server.

// CLIEnv is where a CLI command writes and how it opens a URL in a browser.
type CLIEnv struct {
	Stdout, Stderr io.Writer
	OpenBrowser    func(url string) error
}

// ErrNoServer is every command's answer when no machine server is running.
var ErrNoServer = errors.New("no Juggler server is running on this machine; start one with `juggler serve`")

// cliTimeout bounds one control-API call other than an open: the longest
// answers once its work is done (a stop waits out its child's exit). An open
// has no such bound (OpenSession). A call that outlasts it is ErrServerSlow.
const cliTimeout = childStartTimeout + 10*time.Second

const serverUsage = `Usage: juggler server <command>

Commands:
  status                 Show the running server: address, version, sessions.
  sessions [--json]      List its sessions.
  stop [<id|project>]    Stop one session, or with no argument the whole server.
  lan [on|off]           Show LAN access, or switch it. While it is on, other
                         devices on this network can use the server, with no
                         password. A server starts with it off, unless serve
                         --lan or Settings → Connectivity says to start it.
  tunnel [<mode>|off]    Show the tunnel and the modes this build has, or open
                         one in a mode, or close it. While one is open, anyone
                         with its link can use the server, with no password.
                         A server starts with none open, unless serve --tunnel
                         or Settings → Connectivity names one.
`

// RunServerCommand runs `juggler server <verb>` and returns its exit code.
func RunServerCommand(args []string, env CLIEnv) int {
	if len(args) == 0 {
		fmt.Fprint(env.Stderr, serverUsage)
		return 2
	}
	verb, rest := args[0], args[1:]
	switch verb {
	case "status":
		return cliStatus(env)
	case "sessions":
		fs := flag.NewFlagSet("server sessions", flag.ContinueOnError)
		fs.SetOutput(env.Stderr)
		asJSON := fs.Bool("json", false, "Print the sessions as JSON")
		if err := fs.Parse(rest); err != nil {
			return 2
		}
		return cliSessions(env, *asJSON)
	case "stop":
		if len(rest) > 1 {
			fmt.Fprint(env.Stderr, serverUsage)
			return 2
		}
		if len(rest) == 0 {
			return cliShutdown(env)
		}
		return cliStopSession(env, rest[0])
	case "lan":
		if len(rest) > 1 || (len(rest) == 1 && rest[0] != "on" && rest[0] != "off") {
			fmt.Fprint(env.Stderr, serverUsage)
			return 2
		}
		return cliLAN(env, rest)
	case "tunnel":
		if len(rest) > 1 {
			fmt.Fprint(env.Stderr, serverUsage)
			return 2
		}
		return cliTunnel(env, rest)
	default:
		fmt.Fprintf(env.Stderr, "juggler server: unknown command %q\n\n%s", verb, serverUsage)
		return 2
	}
}

// RunOpenCommand runs `juggler open [--browser] <project>`: it opens (or finds)
// the session for the folder and prints its URL once the session is running,
// requiring a running machine server. The folder is
// taken as typed: relative to where the command runs, or under ~.
func RunOpenCommand(args []string, env CLIEnv) int {
	fs := flag.NewFlagSet("open", flag.ContinueOnError)
	fs.SetOutput(env.Stderr)
	browser := fs.Bool("browser", false, "Also open the session in the default browser")
	fs.Usage = func() {
		fmt.Fprint(env.Stderr, "Usage: juggler open [--browser] <project folder>\n\n"+
			"Opens a session for the folder on this machine's Juggler server and prints its URL.\n")
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}
	project, err := cliPath(fs.Arg(0))
	if err != nil {
		fmt.Fprintf(env.Stderr, "juggler open: %v\n", err)
		return 1
	}
	c, err := Connect(ConnectOptions{})
	if err != nil {
		if errors.Is(err, ErrNoServer) {
			fmt.Fprintln(env.Stderr, "juggler open: no Juggler server is running; run `juggler` in the project first.")
			return 1
		}
		return cliFail(env, "open", err)
	}
	sess, _, err := c.OpenSession(project)
	if err != nil {
		return cliFail(env, "open", err)
	}
	url := c.SessionURL(sess.ID)
	fmt.Fprintln(env.Stdout, url)
	if *browser && env.OpenBrowser != nil {
		if err := env.OpenBrowser(url); err != nil {
			fmt.Fprintf(env.Stderr, "juggler open: could not open a browser: %v\n", err)
			return 1
		}
	}
	return 0
}

func cliStatus(env CLIEnv) int {
	c, err := Connect(ConnectOptions{})
	if err != nil {
		return cliFail(env, "server status", err)
	}
	var st statusResponse
	if err := c.do(http.MethodGet, "/status", nil, &st); err != nil {
		return cliFail(env, "server status", err)
	}
	noun := "sessions"
	if st.Sessions == 1 {
		noun = "session"
	}
	lan := "off"
	if st.LAN {
		lan = "on (juggler server lan for its addresses)"
	}
	fmt.Fprintf(env.Stdout, "Juggler server %s at http://%s/\npid %d, up %s, %d %s\nLAN access: %s\n",
		st.Version, st.Addr, st.PID, time.Since(st.StartedAt).Round(time.Second), st.Sessions, noun, lan)
	return 0
}

func cliSessions(env CLIEnv, asJSON bool) int {
	c, err := Connect(ConnectOptions{})
	if err != nil {
		return cliFail(env, "server sessions", err)
	}
	var list []Session
	if err := c.do(http.MethodGet, "/sessions", nil, &list); err != nil {
		return cliFail(env, "server sessions", err)
	}
	if asJSON {
		enc := json.NewEncoder(env.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(list); err != nil {
			return cliFail(env, "server sessions", err)
		}
		return 0
	}
	if len(list) == 0 {
		fmt.Fprintln(env.Stdout, "No sessions are running.")
		return 0
	}
	tw := tabwriter.NewWriter(env.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tSTATE\tLAST ACTIVE\tPROJECT")
	for _, s := range list {
		last := "-"
		if s.LastActive != nil {
			last = time.Since(*s.LastActive).Round(time.Second).String() + " ago"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", s.ID, cliState(s), last, s.Project)
		if s.Error != "" {
			fmt.Fprintf(tw, "\t\t\t  %s\n", s.Error)
		}
	}
	if err := tw.Flush(); err != nil {
		return cliFail(env, "server sessions", err)
	}
	return 0
}

// cliState is what a session is doing, as the sessions page says it: a
// running session is busy or idle.
func cliState(s Session) string {
	if s.State != SessionRunning {
		return string(s.State)
	}
	if s.Busy {
		return "busy"
	}
	return "idle"
}

func cliShutdown(env CLIEnv) int {
	c, err := Connect(ConnectOptions{})
	if err != nil {
		return cliFail(env, "server stop", err)
	}
	if err := c.do(http.MethodPost, "/shutdown", nil, nil); err != nil {
		return cliFail(env, "server stop", err)
	}
	fmt.Fprintf(env.Stdout, "Stopping the Juggler server at http://%s/ and its sessions.\n", c.addr)
	return 0
}

// cliLAN shows LAN access, or with "on" or "off" switches it first, and says
// where other devices connect from while it is on.
func cliLAN(env CLIEnv, args []string) int {
	c, err := Connect(ConnectOptions{})
	if err != nil {
		return cliFail(env, "server lan", err)
	}
	var st lanResponse
	if len(args) == 1 {
		err = c.do(http.MethodPut, "/lan", map[string]bool{"enabled": args[0] == "on"}, &st)
	} else {
		err = c.do(http.MethodGet, "/lan", nil, &st)
	}
	if err != nil {
		return cliFail(env, "server lan", err)
	}
	if !st.Enabled {
		fmt.Fprintln(env.Stdout, "LAN access is off: the server accepts connections from this machine only.")
		return 0
	}
	fmt.Fprintln(env.Stdout, "LAN access is on, with no password: anyone on this network can use the server.")
	if len(st.URLs) == 0 {
		fmt.Fprintln(env.Stdout, "This machine has no LAN address right now.")
	}
	for _, u := range st.URLs {
		fmt.Fprintf(env.Stdout, "  %s  (%s)\n", u.URL, u.Interface)
	}
	return 0
}

// cliTunnel shows the tunnel and the modes there are, or with a mode opens a
// tunnel in it, or with "off" closes it, and says where to connect from.
func cliTunnel(env CLIEnv, args []string) int {
	c, err := Connect(ConnectOptions{})
	if err != nil {
		return cliFail(env, "server tunnel", err)
	}
	var st tunnelResponse
	switch {
	case len(args) == 0:
		err = c.do(http.MethodGet, "/tunnel", nil, &st)
	case args[0] == "off":
		err = c.do(http.MethodPut, "/tunnel", map[string]string{"mode": ""}, &st)
	default:
		err = c.do(http.MethodPut, "/tunnel", map[string]string{"mode": args[0]}, &st)
	}
	if err != nil {
		return cliFail(env, "server tunnel", err)
	}
	if st.Running == nil {
		fmt.Fprintln(env.Stdout, "The tunnel is off.")
	} else {
		fmt.Fprintln(env.Stdout, "A tunnel is open, with no password: anyone with its link can use the server.")
		fmt.Fprintf(env.Stdout, "  %s\n", st.Running.URL)
	}
	if len(args) > 0 {
		return 0
	}
	if len(st.Modes) == 0 {
		fmt.Fprintln(env.Stdout, "This build has no tunnel modes.")
		return 0
	}
	fmt.Fprintln(env.Stdout, "Modes (juggler server tunnel <mode>):")
	tw := tabwriter.NewWriter(env.Stdout, 0, 0, 2, ' ', 0)
	for _, m := range st.Modes {
		line := fmt.Sprintf("  %v\t%v", m["mode"], m["title"])
		if m["available"] != true {
			line += fmt.Sprintf(" (not available: %v)", m["unavailableHint"])
		}
		fmt.Fprintln(tw, line)
	}
	if err := tw.Flush(); err != nil {
		return cliFail(env, "server tunnel", err)
	}
	return 0
}

// cliStopSession stops the session named by its ID, or by its project folder
// as typed.
func cliStopSession(env CLIEnv, which string) int {
	c, err := Connect(ConnectOptions{})
	if err != nil {
		return cliFail(env, "server stop", err)
	}
	var list []Session
	if err := c.do(http.MethodGet, "/sessions", nil, &list); err != nil {
		return cliFail(env, "server stop", err)
	}
	project, _ := cliPath(which)
	var target *Session
	for i := range list {
		if list[i].ID == which || (project != "" && list[i].Project == project) {
			target = &list[i]
			break
		}
	}
	if target == nil {
		fmt.Fprintf(env.Stderr, "juggler server stop: no session is running for %q (see `juggler server sessions`)\n", which)
		return 1
	}
	if err := c.StopSession(target.ID); err != nil {
		return cliFail(env, "server stop", err)
	}
	fmt.Fprintf(env.Stdout, "Stopped session %s (%s).\n", target.ID, target.Project)
	return 0
}

// cliPath makes a folder given on the command line absolute: under ~, or
// relative to where the command runs. The server takes only absolute paths
// (resolveProject), since its own working directory means nothing to a caller.
func cliPath(p string) (string, error) {
	if p == "" {
		return "", errors.New("no folder given")
	}
	return filepath.Abs(userpaths.ExpandHome(p))
}

func cliFail(env CLIEnv, cmd string, err error) int {
	fmt.Fprintf(env.Stderr, "juggler %s: %v\n", cmd, err)
	return 1
}
