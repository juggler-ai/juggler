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
// while it answers GET /api/version at the address it announced, and what it
// is switched to is that address, shown on its row: never a name the
// announcement chose. A server on one of this machine's own addresses is this
// machine's (there is one per machine) and is not listed.

// foundServer is one server the discover action lists.
type foundServer struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Version string `json:"version,omitempty"`
}

// serverSource is what the finder browses with: a *lanfind.Browser, or a
// test's stand-in.
type serverSource interface {
	Snapshot() []lanfind.Found
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
}

// finderIdle is how long the browse runs after the last page asked. A page
// showing asks every few seconds, so this outlasts any pause between asks.
const finderIdle = 2 * time.Minute

// probeTimeout bounds one GET /api/version: a server that cannot answer that
// quickly on the same network is not listed this time round, and is asked
// again on the page's next ask.
const probeTimeout = 1500 * time.Millisecond

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
func (f *lanFinder) source() (serverSource, error) {
	f.asked.Store(time.Now().UnixNano())
	for {
		if p := f.src.Load(); p != nil {
			return *p, nil
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
func (f *lanFinder) servers(ctx context.Context) ([]foundServer, error) {
	src, err := f.source()
	if err != nil {
		return nil, err
	}
	local := f.localAddrs()
	found := src.Snapshot()
	answers := make([]chan *foundServer, len(found))
	for i, s := range found {
		answers[i] = make(chan *foundServer, 1)
		go func() {
			answers[i] <- f.answering(ctx, s, local)
		}()
	}
	out := []foundServer{}
	for _, ch := range answers {
		if s := <-ch; s != nil {
			out = append(out, *s)
		}
	}
	return out, nil
}

// answering is s as listed, at whichever of its addresses first answers as a
// Juggler server, or nil when s is this machine's or none of them answer. Its
// addresses are asked at once — one it has since left costs nothing while
// another answers — and the asks still out are called off once one has, and
// waited for, so none outlives the discover action that made it.
func (f *lanFinder) answering(ctx context.Context, s lanfind.Found, local map[netip.Addr]bool) *foundServer {
	var urls []string
	for _, a := range s.Addrs {
		if local[a] {
			return nil
		}
		if a.Is6() && a.Zone() == "" && a.IsLinkLocalUnicast() {
			continue // unusable without the interface it is on
		}
		// url.URL escapes a zone's "%" as "%25", which an address written
		// into the URL bare would leave as an escape that does not parse.
		u := url.URL{Scheme: "http", Host: net.JoinHostPort(a.String(), strconv.Itoa(s.Port))}
		urls = append(urls, u.String())
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	answers := make(chan *foundServer, len(urls))
	for _, u := range urls {
		go func() {
			if version, ok := f.probe(ctx, u); ok {
				answers <- &foundServer{Name: s.Name, URL: u, Version: version}
				return
			}
			answers <- nil
		}()
	}
	var first *foundServer
	for range urls {
		if found := <-answers; found != nil && first == nil {
			first = found
			cancel()
		}
	}
	return first
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
