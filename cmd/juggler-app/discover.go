//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"sync/atomic"
	"time"

	"juggler/internal/lanfind"
)

// Finding servers on the network: the sessions page's server chooser lists the
// Juggler servers other computers announce while their LAN access is on
// (lanfind), each to switch to with a click. The page asks with
// the discover action while it shows; the app browses only while some page has
// asked lately, and answers with what it has found.
//
// An announcement proves nothing — anyone on the network can send one — and
// the mDNS layer never says a server has gone. So a server is listed only
// while it answers GET /api/version at an address it announced — or, having
// answered, through the odd ask it misses (missesForgiven) — and what it is
// switched to is that address, shown on its row: never a name the
// announcement chose. A server on one of this machine's own addresses is this
// machine's (there is one per machine) and is not listed.

// foundServer is one server the discover action lists: at URL, the address it
// answered at, among URLs, every address it was announced at — which a page
// matches the server its window shows against, whichever address that is.
type foundServer struct {
	Name    string   `json:"name"`
	URL     string   `json:"url"`
	URLs    []string `json:"urls,omitempty"`
	Version string   `json:"version,omitempty"`
}

// listing is what one server was last listed as, and how many asks in a row it
// has since failed to answer.
type listing struct {
	server foundServer
	misses int
}

// serverSource is what the finder browses with: a *lanfind.Browser, or a
// test's stand-in.
type serverSource interface {
	Snapshot() []lanfind.Found
	SendFailed() bool
	Close()
}

// lanFinder is the app's one browse for servers, started by the first page to
// ask and stopped once none has asked for finderIdle.
type lanFinder struct {
	// browse starts a browse (lanfind.Browse); probe asks the server at url for
	// its version, ok false when it does not answer as a Juggler server does;
	// localAddrs are this machine's addresses.
	browse     func() (serverSource, error)
	probe      func(ctx context.Context, url string) (version string, ok bool)
	localAddrs func() map[netip.Addr]bool

	src   atomic.Pointer[serverSource]
	asked atomic.Int64 // unix nanos of the latest ask
	// failing is raised while browses fail, so the log says so once, not on
	// every ask.
	failing atomic.Bool

	// listed is what each server found was last listed as, by its name and
	// port: the address it is listed at again while that answers, and what it
	// is listed as through a missed answer (missesForgiven). Each ask swaps in
	// a whole new map; of two asks at once, the later to finish is kept.
	listed atomic.Pointer[map[string]listing]
}

// finderIdle is how long the browse runs after the last page asked. A page
// showing asks every few seconds, so this outlasts any pause between asks.
const finderIdle = 2 * time.Minute

// probeTimeout bounds one GET /api/version: a server that cannot answer that
// quickly on the same network is not listed this time round, and is asked
// again on the page's next ask.
const probeTimeout = 1500 * time.Millisecond

// missesForgiven is how many asks in a row a server listed before may fail to
// answer and still be listed, as it last answered.
const missesForgiven = 2

func newLANFinder() *lanFinder {
	return &lanFinder{
		browse: func() (serverSource, error) {
			b, err := lanfind.Browse()
			if err != nil {
				return nil, err
			}
			return b, nil
		},
		probe:      probeVersion,
		localAddrs: localAddrs,
	}
}

// source is the running browse, started if none is. Two first asks at once
// both start one; the loser closes its own and takes the winner's — or, should
// that have gone idle and stopped in between, starts again.
//
// A browse whose queries failed and that has found nothing is replaced: on
// macOS it was opened while the app was refused the local network — at the
// first ask, which brings up the prompt, or just after a rebuild — and hears
// nothing even once the user allows it. One that has found servers is
// hearing, and is kept.
func (f *lanFinder) source() (serverSource, error) {
	f.asked.Store(time.Now().UnixNano())
	for {
		if p := f.src.Load(); p != nil {
			if !(*p).SendFailed() || len((*p).Snapshot()) > 0 {
				return *p, nil
			}
			if f.src.CompareAndSwap(p, nil) {
				(*p).Close()
			}
			continue
		}
		src, err := f.browse()
		if err != nil {
			if !f.failing.Swap(true) {
				logf("discover: not browsing the network: %v", err)
			}
			return nil, err
		}
		f.failing.Store(false)
		if f.src.CompareAndSwap(nil, &src) {
			go f.stopWhenIdle(&src)
			return src, nil
		}
		src.Close()
	}
}

// stopWhenIdle closes the browse p once no page has asked for finderIdle.
func (f *lanFinder) stopWhenIdle(p *serverSource) {
	t := time.NewTicker(finderIdle / 4)
	defer t.Stop()
	for range t.C {
		if time.Since(time.Unix(0, f.asked.Load())) < finderIdle {
			continue
		}
		if f.src.CompareAndSwap(p, nil) {
			(*p).Close()
		}
		return
	}
}

// servers is every server found that answers, other than this machine's own,
// in the order the browse lists them (by name). Each found server is asked at
// once, so one that does not answer costs probeTimeout, not one per server.
//
// A server is listed at the address it was listed at before while that
// answers, whichever of its addresses answers first, so the row a window's
// server is listed as holds still from one ask to the next; and one listed
// before that misses an ask is listed as before until it has missed
// missesForgiven in a row.
func (f *lanFinder) servers(ctx context.Context) ([]foundServer, error) {
	src, err := f.source()
	if err != nil {
		return nil, err
	}
	local := f.localAddrs()
	found := src.Snapshot()
	keys := make([]string, len(found))
	answers := make([]chan *foundServer, len(found))
	before := map[string]listing{}
	if p := f.listed.Load(); p != nil {
		before = *p
	}
	prefer := make([]string, len(found))
	for i, s := range found {
		keys[i] = s.Name + "\x00" + strconv.Itoa(s.Port)
		prefer[i] = before[keys[i]].server.URL
	}
	for i, s := range found {
		answers[i] = make(chan *foundServer, 1)
		go func() {
			answers[i] <- f.answering(ctx, s, local, prefer[i])
		}()
	}
	got := make([]*foundServer, len(found))
	for i, ch := range answers {
		got[i] = <-ch
	}

	listed := make(map[string]listing, len(found))
	out := []foundServer{}
	for i, s := range got {
		if s == nil {
			l, ok := before[keys[i]]
			if !ok || l.misses >= missesForgiven || isLocal(found[i], local) {
				continue
			}
			l.misses++
			listed[keys[i]] = l
			out = append(out, l.server)
			continue
		}
		listed[keys[i]] = listing{server: *s}
		out = append(out, *s)
	}
	f.listed.Store(&listed)
	return out, nil
}

// isLocal is whether s is on one of this machine's own addresses.
func isLocal(s lanfind.Found, local map[netip.Addr]bool) bool {
	for _, a := range s.Addrs {
		if local[a] {
			return true
		}
	}
	return false
}

// answering is s as listed, at prefer — the address it was listed at before —
// when that answers as a Juggler server, else at whichever of its addresses
// first does, or nil when s is this machine's or none of them answer. Its
// addresses are asked at once — one it has since left costs nothing while
// another answers — and the asks still out are called off once one is chosen,
// and waited for, so none outlives the discover action that made it.
func (f *lanFinder) answering(ctx context.Context, s lanfind.Found, local map[netip.Addr]bool, prefer string) *foundServer {
	if isLocal(s, local) {
		return nil
	}
	var urls []string
	for _, a := range s.Addrs {
		if a.Is6() && a.IsLinkLocalUnicast() {
			// Unusable without its zone, and a window cannot open a URL with
			// one: the WHATWG URL a web view parses has no zone syntax, so
			// WebKit and WebView2 both refuse it. Listed, it would answer the
			// probe here and then fail as the window's address.
			continue
		}
		u := url.URL{Scheme: "http", Host: net.JoinHostPort(a.String(), strconv.Itoa(s.Port))}
		urls = append(urls, u.String())
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type answer struct {
		url     string
		version string
		ok      bool
	}
	answers := make(chan answer, len(urls))
	for _, u := range urls {
		go func() {
			version, ok := f.probe(ctx, u)
			answers <- answer{u, version, ok}
		}()
	}
	// chosen is the answer listed, once known: prefer's, or — once prefer has
	// failed, or with none to wait for — the first other.
	var chosen, other *answer
	waiting := slices.Contains(urls, prefer)
	for range urls {
		got := <-answers
		switch {
		case got.url == prefer:
			waiting = false
			if got.ok && chosen == nil {
				chosen = &got
			}
		case got.ok && other == nil:
			other = &got
		}
		if chosen == nil && !waiting {
			chosen = other
		}
		if chosen != nil {
			cancel()
		}
	}
	if chosen == nil {
		return nil
	}
	return &foundServer{Name: s.Name, URL: chosen.url, URLs: urls, Version: chosen.version}
}

// probeHTTP is the client a probe asks with; its timeout is probeTimeout. It
// follows no redirect: the server listed is the one at the address announced,
// which is what Connect opens, so an answer from anywhere else is no answer.
var probeHTTP = &http.Client{
	Timeout: probeTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// probeVersion asks the server at serverURL for GET /api/version, which a
// Juggler machine server answers without a token from anyone its LAN gate
// lets in.
func probeVersion(ctx context.Context, serverURL string) (string, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, serverURL+"/api/version", nil)
	if err != nil {
		return "", false
	}
	resp, err := probeHTTP.Do(req) //nolint:gosec // an address announced on this network, asked only for its version
	if err != nil {
		return "", false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	var v struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<12)).Decode(&v); err != nil || v.Version == "" {
		return "", false
	}
	return v.Version, true
}

// localAddrs is every address on this machine's interfaces.
func localAddrs() map[netip.Addr]bool {
	out := map[netip.Addr]bool{}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(n.IP); ok {
				out[ip.Unmap()] = true
			}
		}
	}
	return out
}

// controlDiscover answers a sessions page asking which servers are on the
// network: {"servers": [{name, url, version}]}. A browse that cannot start
// (no multicast here, the OS refusing it) answers with none, as a network with
// no servers on it would: the page offers the address field either way.
//
// Refused to a page a server by URL sent (windowActions), as switch-server
// is: the list is for choosing a server to switch to, which only this
// machine's server's pages may do.
func (a *appState) controlDiscover(w http.ResponseWriter, r *http.Request, _ *winEntry) {
	servers, err := a.finder.servers(r.Context())
	if err != nil {
		servers = []foundServer{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"servers": servers})
}
