//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package gitaskpass is how a git command the server runs asks the user for a
// credential: a username, a password, an ssh key's passphrase, whether to trust
// a host it has not seen.
//
// Git and ssh ask by running the program GIT_ASKPASS or SSH_ASKPASS names with
// the prompt as its one argument, and take what it prints as the answer. That
// program is the server's own binary run again: app.Run checks Invoked before
// anything else and hands the process to Main. So there is no second binary to
// build, sign and ship, and the cost is the binary's start-up — its package
// initialisers — once per question.
//
// Main sends the prompt to the address in EnvAddr, a listener of the server's
// on loopback, with the token in EnvToken, which names the one git job the
// question belongs to; it waits for the answer, prints it and exits 0. It exits
// 1 — which git and ssh take as "no answer" — when the question is declined,
// the job is cancelled or ends, or the server is gone.
//
// Classify is the server's half: what kind of answer a prompt wants.
package gitaskpass

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// Kind is what a question wants for an answer.
type Kind string

const (
	KindText    Kind = "text"    // typed in the open: a username
	KindSecret  Kind = "secret"  // typed masked: a password, a passphrase, a PIN
	KindConfirm Kind = "confirm" // yes or no: a host key, a key's use
	KindNotice  Kind = "notice"  // nothing: ssh says something (touch your key) and ignores the answer
)

// The variables the helper is reached through, and the path it asks on.
const (
	EnvAddr  = "JUGGLER_GIT_ASKPASS"       // host:port of the server's askpass listener
	EnvToken = "JUGGLER_GIT_ASKPASS_TOKEN" // the job the question belongs to
	Path     = "/askpass"
)

// Request is one question, as the helper sends it.
type Request struct {
	Token  string `json:"token"`
	Prompt string `json:"prompt"`
	// SSHPrompt is ssh's SSH_ASKPASS_PROMPT: "confirm" for a yes/no, "none"
	// for a notice; "" when git asks, or ssh asks for a secret.
	SSHPrompt string `json:"sshPrompt,omitempty"`
}

// Answer is the server's reply: the answer, or that there is none.
type Answer struct {
	Answer   string `json:"answer,omitempty"`
	Declined bool   `json:"declined,omitempty"`
}

// Classify says what kind of answer a prompt wants. Git's and ssh's words are
// read as they print them under LC_ALL=C, which every network command runs
// with. A prompt nothing here recognises is taken to want a secret, so a
// question nobody has seen before is at worst masked when it need not be.
func Classify(prompt, sshPrompt string) Kind {
	switch strings.ToLower(sshPrompt) {
	case "confirm":
		return KindConfirm
	case "none":
		return KindNotice
	}
	switch {
	case strings.HasPrefix(prompt, "Username for "):
		return KindText
	case strings.Contains(prompt, "(yes/no"):
		return KindConfirm
	}
	return KindSecret
}

// Invoked reports whether this process is git or ssh asking a question: both
// variables set, and one argument with a space in it. A prompt always has one
// and a subcommand or flag never does, so a run of the binary that only
// inherited the variables — a pre-push hook calling `juggler server status` —
// is left to run as itself.
func Invoked(args []string, getenv func(string) string) bool {
	if getenv(EnvAddr) == "" || getenv(EnvToken) == "" || len(args) != 1 {
		return false
	}
	return strings.ContainsAny(args[0], " \t\n")
}

// Env is the environment a network command is given so that its questions
// come to the server: git's and ssh's askpass both the helper, ssh made to use
// it even when there is a terminal it could ask on, and DISPLAY — without
// which an ssh older than SSH_ASKPASS_REQUIRE runs no askpass — when unset.
func Env(exe, addr, token string, getenv func(string) string) []string {
	env := []string{
		"GIT_ASKPASS=" + exe,
		"SSH_ASKPASS=" + exe,
		"SSH_ASKPASS_REQUIRE=force",
		EnvAddr + "=" + addr,
		EnvToken + "=" + token,
	}
	if getenv("DISPLAY") == "" {
		env = append(env, "DISPLAY=:0")
	}
	return env
}

// Main asks the server the question in args[0], prints the answer and returns
// the exit status: 0 answered, 1 not. Nothing about the answer goes anywhere
// but stdout; a failure to ask says why on stderr, which git shows as part of
// its own failure.
func Main(args []string, getenv func(string) string, stdout io.Writer) int {
	answer, err := ask(args, getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "juggler askpass: %v\n", err)
		return 1
	}
	if answer.Declined {
		return 1
	}
	if _, err := fmt.Fprintln(stdout, answer.Answer); err != nil {
		return 1
	}
	return 0
}

func ask(args []string, getenv func(string) string) (Answer, error) {
	if len(args) != 1 {
		return Answer{}, fmt.Errorf("want one prompt, got %d arguments", len(args))
	}
	body, err := json.Marshal(Request{Token: getenv(EnvToken), Prompt: args[0], SSHPrompt: getenv("SSH_ASKPASS_PROMPT")})
	if err != nil {
		return Answer{}, err
	}
	// The listener is on loopback, so no proxy; and no timeout, because the
	// question waits on a person. It ends when they answer, or the server
	// declines it, or the connection drops.
	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	resp, err := client.Post("http://"+getenv(EnvAddr)+Path, "application/json", bytes.NewReader(body))
	if err != nil {
		return Answer{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return Answer{}, fmt.Errorf("the server refused the question: %s", resp.Status)
	}
	var answer Answer
	if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
		return Answer{}, err
	}
	return answer, nil
}
