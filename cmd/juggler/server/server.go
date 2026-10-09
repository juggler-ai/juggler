//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/syswake"
	"juggler/cmd/juggler/worker"
	"juggler/internal/jlog"
	"juggler/internal/updatecheck"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

// Timeout configuration for background provider/model operations.
const (
	// ProviderInitTimeout bounds a single upstream model-list call. Kept short
	// so that a slow / hung upstream cannot accumulate live TLS connections
	// across repeated UI-driven /api/providers requests.
	ProviderInitTimeout = 10 * time.Second

	// ProvidersReadyTimeout bounds how long a default-model lookup waits for the
	// first provider refresh to populate the cache before deriving an answer
	// from whatever is cached. It exceeds ProviderInitTimeout so the slowest
	// provider's model discovery (e.g. the claudecode CLI) can complete.
	ProvidersReadyTimeout = ProviderInitTimeout + 2*time.Second
)

// sameOriginCheck is the WebSocket upgrader's Origin gate. Browsers send an
// Origin header on cross-origin WebSocket handshakes; a same-origin page
// either omits it or sends one whose host matches the request's Host header.
// Non-browser clients (CLI tools, integration tests) typically omit Origin,
// which we allow — the LAN gate middleware already restricts who can reach
// the listener. The check exists to stop a different web page the user is
// browsing from opening a socket to the local agent.
//
// Every client — LAN browsers, the desktop app's windows, and the hidden
// engine WebView — reaches the server over plain http://<addr>/..., so their
// Origin matches r.Host uniformly and the check needs no special cases.
func sameOriginCheck(r *http.Request) bool {
	// Modern browsers stamp Sec-Fetch-Site on the handshake; a "cross-site" value
	// is a definitive cross-origin signal even when Origin is absent or spoofed,
	// so reject it outright before trusting the Origin/Host comparison below.
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return u.Host == r.Host
}

// unmarshalWS decodes a raw WebSocket message into T, logging a parse error and
// returning ok=false on failure. The caller should `continue` the read loop on
// ok=false.
func unmarshalWS[T any](data []byte, label string) (T, bool) {
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		jlog.Error("WebSocket: failed to parse %s: %v", label, err)
		return v, false
	}
	return v, true
}

// serverAPIs are the handler groups the /api surface is split across, each
// owning one slice of it and constructed once in New. Embedded in Server, so
// every call site still reads s.opsAPI — the grouping is for the declaration,
// not the callers.
type serverAPIs struct {
	opsAPI            *handlers.OpsAPI
	completionsAPI    *handlers.CompletionsAPI
	gitStatusAPI      *handlers.GitStatusAPI
	extensionsAPI     *handlers.ExtensionsAPI
	userCommandsAPI   *handlers.UserCommandsAPI
	skillsAPI         *handlers.SkillsAPI
	skillsRegistryAPI *handlers.SkillsRegistryAPI
	configAPI         *handlers.ConfigAPI
	sessionAPI        *handlers.SessionAPI // Kept so RegisterTestRoutes can wire test-mode hooks
	// systemPromptPresetsAPI serves user-saved system-prompt presets and the
	// chosen session-default preset id (~/.juggler/system-prompt-presets.json).
	systemPromptPresetsAPI *handlers.SystemPromptPresetsAPI
}

// serverStores are the JSON-backed preference stores under ~/.juggler, all
// user-global rather than per-project. Embedded in Server.
//
// The global settings document is deliberately NOT here: it is written later in
// New than these four, and keeping it out is what lets this group be assigned as
// one literal without a later write being at risk of being wiped.
type serverStores struct {
	defaultModelStore *core.DefaultModelStore
	cheapModelStore   *core.CheapModelStore
	recentsStore      *core.RecentsStore
	recentModelsStore *core.RecentModelsStore
}

// providerRefresh is the provider/model snapshot and the actor that recomputes
// it. Embedded in Server.
//
// New assigns this group field-by-field rather than as a literal, because only
// some of it is set there: providersList and providersReadyOnce start zero and
// computeProvidersFunc is a test seam. A literal covering part of a group is
// the wipe hazard documented in New.
type providerRefresh struct {
	// providersList holds the most recent push-only provider/model snapshot.
	// Populated by RefreshProviders at startup and after each credential
	// mutation; consumed by handleProviders / handleGetContextWindow and
	// broadcast to all clients via the providers-update WS event.
	providersList atomic.Pointer[[]ProviderStatus]
	// refreshRequests is the provider-refresh actor's size-1 dirty latch. A burst
	// coalesces while idle or computing; a request accepted during a computation
	// remains queued and therefore guarantees one subsequent computation.
	refreshRequests chan struct{}
	// computeProvidersFunc is an immutable test seam for deterministic refresh
	// coordination. Production leaves it nil and uses computeProviders.
	computeProvidersFunc func(context.Context) []ProviderStatus
	// providersReady is closed once the first provider refresh completes.
	// Lookups that derive their answer from the live provider list (the
	// implicit default-model selection) wait on it so a conversation created
	// during the startup discovery window is seeded from the real provider set
	// rather than the still-empty cache. providersReadyOnce guards the close.
	providersReady     chan struct{}
	providersReadyOnce sync.Once
}

// wsFleet is the WebSocket side of the server: how a connection is upgraded,
// who is connected, and what is accounted. Embedded in Server.
//
// New assigns this group field-by-field: hub and stats are created after the
// upgrader, and engineClient is only ever set on an engine-role upgrade.
type wsFleet struct {
	upgrader websocket.Upgrader
	// hub owns the set of all connected WebSocket clients — used for full-fleet
	// broadcasts (project-changed, providers-update, shutdown notices).
	hub *clientHub
	// engineClient is the headless engine WS connection, or nil. Set on
	// engine-role upgrade and cleared on disconnect.
	engineClient atomic.Pointer[WSClient]
	// engineHeartbeatAt is when the engine's JS realm last proved it is running,
	// as unix nanoseconds. An open socket is not proof (see engine_liveness.go),
	// so this — not engineClient alone — is what IsEngineConnected answers from.
	engineHeartbeatAt atomic.Int64
	// engineLivenessWindowNs overrides engineLivenessWindow when non-zero.
	// Test-only seam, so a test need not wait out the production window.
	engineLivenessWindowNs atomic.Int64
	// engineSilenceReported latches the log line for a live→silent transition, so
	// a wedged engine costs one line rather than one per poll. Reset on connect.
	engineSilenceReported atomic.Bool
	// engineEvictedAt is when the supervisor last closed a silent engine's socket,
	// as unix nanoseconds, or 0 when no eviction is outstanding. It is what
	// distinguishes an engine we killed and are waiting on from one that simply
	// never connected.
	engineEvictedAt atomic.Int64
	// engineRecoveries counts recovery-hook calls since the last healthy engine,
	// capped by maxEngineRecoveries.
	engineRecoveries atomic.Int32
	// engineFlapWindowStart is when the current run of engine connections began,
	// as unix nanoseconds, and engineAttachCount is how many have landed since.
	// An engine that dies and comes straight back leaves no other trace — it is
	// neither silent nor evicted — so this pair is the only place a reconnect
	// loop is visible. See noteEngineAttached.
	engineFlapWindowStart atomic.Int64
	engineAttachCount     atomic.Int32
	// engineFlapReported latches the reconnect-loop line, so a loop costs one
	// line rather than adding its own noise to the flood it is reporting.
	engineFlapReported atomic.Bool
	// engineRecovery reloads the engine host when eviction alone did not bring it
	// back. Installed by the app layer, which owns the window; nil elsewhere.
	engineRecovery atomic.Pointer[EngineRecovery]
	// serverBeatIntervalNs overrides serverBeatInterval when non-zero, and with it
	// the link-check tick derived from it. Test-only seam (see link_liveness.go).
	serverBeatIntervalNs atomic.Int64
	// viewerSilenceWindowNs overrides viewerSilenceWindow when non-zero, so a test
	// need not wait out the production one. Test-only seam.
	viewerSilenceWindowNs atomic.Int64
	// stats, when non-nil (JUGGLER_WS_STATS set), accounts WebSocket payload
	// bytes per direction / message type and periodically logs a table plus the
	// modeled permessage-deflate ratio. Diagnostic only; nil in normal runs.
	stats *wsStats
}

// Server represents the HTTP server
type Server struct {
	serverAPIs
	serverStores
	providerRefresh
	wsFleet

	router          *mux.Router
	addr            string
	listener        net.Listener // Bound listener (set after BindPort())
	devMode         bool         // Inspector / right-click menu + front-end JUGGLER_DEV_MODE (no source checkout needed)
	assetsFromDisk  bool         // Serve web assets from the on-disk web/ tree with live reload (requires a source checkout)
	testMode        bool         // Set when test routes are registered; disables network calls in provider listing
	bootProjectPath string

	indexTemplate *template.Template // Template for index.html with cache busting
	staticVersion string             // Random version string for cache-busted static paths
	apiToken      string             // Per-instance token gating the sensitive /api surface + viewer WS (see api_auth.go)
	// bootID names this server instance to its clients, in the session message
	// every connection is seeded with. It is minted next to staticVersion and
	// apiToken because it stands for exactly those two: a page served by one
	// instance carries that instance's token and its cache-busted asset URLs, so
	// against a different instance every guarded API call is refused and every
	// dynamic import 404s. A client that reconnects and reads an unchanged boot
	// id knows the link merely blipped and can catch up with a Yjs state-vector
	// resync; a changed one means the page itself is stale and must be reloaded.
	bootID         string
	startTime      time.Time // Server start time for health/instance endpoint
	shutdownChan   chan struct{}
	shutdownOnce   sync.Once
	workerManager  *worker.Manager     // Go worker manager
	extraRoutes    func(r *mux.Router) // Optional Config.ExtraRoutes hook, invoked at the end of setupRoutes
	exitWithParent bool                // Config.ExitWithParent: server self-terminates when its parent (the viewer) dies; reported on /api/health/instance
	loopbackOnly   bool                // Config.LoopbackOnly: bind 127.0.0.1 instead of every interface
	ingressSecret  string              // Config.IngressSecret: the supervisor's proof that a caller is off loopback ("" when there is no supervisor)

	// conversationCache holds the per-conversation Provider.Conversation
	// handles: one handle per (convID, providerName, model), opened lazily
	// on first LLM call, closed on conversation delete or server shutdown.
	conversationCache *conversationCache

	// quickCompleteSem is a counting semaphore bounding concurrent out-of-band
	// QuickComplete calls (the /api/llm/complete endpoint + the auto-namer), so
	// plugins can't turn the endpoint into a provider firehose. Buffered to the
	// cap; a full buffer means an over-cap caller is rejected fast rather than
	// queued. Created in the server constructor.
	quickCompleteSem chan struct{}

	// cheapModelNoticeOnce holds the one nudge a run gets about there being no
	// cheap model to run micro-tasks on (see cheapModelForTask). Per-run rather
	// than persisted: the message is about configuration, so a restart is a fair
	// moment to mention it again, and nothing has to be written down.
	cheapModelNoticeOnce sync.Once

	publicMode atomic.Bool                  // true = accept connections from non-localhost IPs
	tunnel     atomic.Pointer[activeTunnel] // non-nil when a tunnel is active

	// webrtcCert is this machine's persistent WebRTC identity: the DTLS
	// certificate presented on every peer connection, loaded once at startup
	// from the per-user config dir (see webrtc_identity.go) and reused across
	// restarts so the peer's fingerprint — and therefore any Direct P2P link a
	// remote client pins to it — stays stable. nil only if load/create failed,
	// in which case pion mints an ephemeral certificate per connection (the
	// pre-persistence behaviour).
	webrtcCert *webrtc.Certificate

	// Per-project state, swapped atomically on project change.
	projectState atomic.Pointer[projectState]
	switchToken  chan struct{} // size-1 token; serializes SwitchProject

	// updateChecker polls the remote version manifest (juggler.studio) and holds
	// the latest "new version available" decision in memory. Created in New; its
	// poll loop is started by StartBackgroundServices (production only — skipped in test
	// mode so the suite never reaches the network). nil only before New finishes.
	updateChecker *updatecheck.Checker

	// settings owns the global settings document (~/.juggler/settings.json),
	// the single source of truth for the user's update mode. Created in New; the
	// update-checker's Enabled gate and the /api/settings handlers read/write
	// through it. nil only before New finishes (and in bare test Servers).
	settings *settingsStore

	// oneShot is the round-trip behind `juggler run`: one prompt handed to the
	// engine, one result back. Idle in every other run (see one_shot.go).
	oneShot oneShotRoundTrip

	// engineReadyGate, when set, is called at the start of every LLM turn (and
	// before a worker-driven strategy hook) to guarantee the hidden engine
	// WebView is connected before the turn can emit any tool request. Returns
	// false if the engine did not connect in time. Nil in test mode and the
	// test-pool, where the engine is an always-connected iframe.
	engineReadyGate atomic.Pointer[EngineReadyGate]
}

// EngineReadyGate blocks until the always-alive hidden engine WebView is
// connected and ready to execute tools, returning true on success. Wired from
// the production headless path via SetEngineReadyGate (see startEngine); it only
// ever blocks during the startup connect window or a watchdog re-exec restart.
type EngineReadyGate func() bool

// Config contains server configuration
type Config struct {
	SessionManager *core.SessionManager
	Host           string
	Port           int
	DevMode        bool               // If true, enable the web inspector / right-click menu (front-end dev mode); no source checkout required
	AssetsFromDisk bool               // If true, serve static files from the on-disk web/ tree with live reload; requires a source checkout
	ProjectPath    string             // Project root path (for resolving static files when AssetsFromDisk is set)
	BootLock       *core.InstanceLock // Optional boot-time instance lock; ownership transfers to server.
	// ExtraRoutes, if set, is called at the end of setupRoutes with the
	// server's router, so a wrapping distribution can register additional
	// HTTP routes without editing this package. Routes registered here pass
	// through the same router-wide middleware as built-ins: CORS, cache
	// control, the LAN gate, and — for paths under /api/ — the per-instance
	// session-token auth (see apiAuthMiddleware). Must not shadow existing
	// routes.
	ExtraRoutes func(r *mux.Router)

	// ExitWithParent mirrors the server's --exit-with-parent flag: true when a
	// parent process (the juggler-app viewer) owns this server's lifetime and it
	// self-terminates once that parent dies. Surfaced on /api/health/instance so
	// a discovering viewer can tell an about-to-exit orphan from a durable server.
	ExitWithParent bool

	// LoopbackOnly binds the listener to 127.0.0.1 rather than every
	// interface. A machine-server session child sets it: it is reached only
	// through its supervisor's proxy, so nothing off this machine should be
	// able to connect to it at all — not merely be refused by the LAN gate.
	LoopbackOnly bool

	// IngressSecret is the secret a machine-server session child was spawned
	// with (internal/ingress). A request carrying it in ingress.Header is one
	// the supervisor forwarded from a caller off loopback, and is tagged as
	// remote ingress (see supervisorIngressMiddleware). Empty for any other
	// server, which then ignores the header.
	IngressSecret string
}

// New creates a new server
func New(cfg Config) (*Server, error) {
	if cfg.SessionManager == nil {
		return nil, fmt.Errorf("session manager is required")
	}

	router := mux.NewRouter()
	upgrader := newWSUpgrader()

	wm := worker.NewManager()

	// When the OS resumes from sleep, cancel any in-flight LLM request whose
	// connection the sleep likely dropped, so the turn fails fast instead of
	// riding the LLMTimeout backstop. syswake.Fire() is called from the
	// platform sleep/wake observer (darwin: the NSWorkspace DidWake hook).
	syswake.OnWake(wm.SystemDidWake)

	// Server skeleton created up-front so handler providers can close over its accessors.
	s := &Server{}

	sessionAPI := handlers.NewSessionAPI(s.SessionManager, wm, serverBroadcaster{srv: s}, func(convID string) {
		// Closure captures the (yet-to-be-set) cache pointer on s so
		// SessionAPI can release conversation-scoped provider resources
		// on delete without depending on this package's types.
		if cc := s.conversationCache; cc != nil {
			cc.CloseConversation(convID)
		}
	}, s.resolveDefaultModel)

	configAPI, err := handlers.NewConfigAPI(s.ProjectPath, s.RefreshProviders, func() {
		s.broadcastToAll(map[string]any{"type": "plugin-changed", "path": "config/plugins"})
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create config API: %w", err)
	}
	// Hand the config API the customisable half of the built-in auto-name prompt
	// so the settings UI shows it verbatim as the custom-instruction placeholder.
	// The fixed data guard is appended server-side and never surfaced.
	configAPI.AutoNameDefaultPrompt = autoNameTitleInstruction

	defaultModelStore, err := core.NewDefaultModelStore()
	if err != nil {
		return nil, fmt.Errorf("failed to create default model store: %w", err)
	}

	cheapModelStore, err := core.NewCheapModelStore()
	if err != nil {
		return nil, fmt.Errorf("failed to create cheap model store: %w", err)
	}

	systemPromptPresetStore, err := core.NewSystemPromptPresetStore()
	if err != nil {
		return nil, fmt.Errorf("failed to create system prompt preset store: %w", err)
	}

	extensionsAPI := createExtensionsAPI(cfg.AssetsFromDisk)

	staticVersion := generateStaticVersion()
	recents, _ := core.NewRecentsStore()
	recentModels, _ := core.NewRecentModelsStore()

	// Field-by-field initialization of the up-front skeleton — NEVER replace
	// this with a wholesale `*s = Server{...}` literal: the skeleton pointer
	// has already been captured by closures and constructors above, and a
	// struct-literal reassignment silently zeroes every field assigned to `s`
	// before it (this exact bug shipped once: sessionAPI was set on the
	// skeleton, wiped by the literal, and the test-mode ownership guard ran
	// unwired through a full green suite).
	//
	// The same hazard applies to the embedded groups, which is why only the two
	// lock-free ones are assigned as literals below, each exactly once and
	// covering every field it declares. A group written in more than one place
	// must be assigned field-by-field, or the second write wipes the first.
	skillsAPI := handlers.NewSkillsAPI(s.ProjectPath)
	s.serverAPIs = serverAPIs{
		// Workspaces are resolved through the live session manager on each
		// request, for the same reason the project path is a provider func: a
		// project switch retargets both, and a workspace registered a moment
		// ago must resolve without rebuilding anything.
		opsAPI: handlers.NewOpsAPI(s.ProjectPath, s.WorkspaceLookup()),
		completionsAPI: handlers.NewCompletionsAPI(s.ProjectPath, s.WorkspaceLookup(), func() ops.PathSearcher {
			if fw := s.FileWatcher(); fw != nil {
				return fw.Index()
			}
			return nil
		}),
		gitStatusAPI:      handlers.NewGitStatusAPI(s.ProjectPath, s.WorkspaceLookup()),
		extensionsAPI:     extensionsAPI,
		userCommandsAPI:   handlers.NewUserCommandsAPI(s.ProjectPath),
		skillsAPI:         skillsAPI,
		skillsRegistryAPI: handlers.NewSkillsRegistryAPI(s.ProjectPath, skillsAPI),
		configAPI:         configAPI,
		sessionAPI:        sessionAPI,

		systemPromptPresetsAPI: handlers.NewSystemPromptPresetsAPI(systemPromptPresetStore),
	}
	s.serverStores = serverStores{
		defaultModelStore: defaultModelStore,
		cheapModelStore:   cheapModelStore,
		recentsStore:      recents,
		recentModelsStore: recentModels,
	}

	s.router = router
	s.upgrader = upgrader
	s.addr = fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	s.devMode = cfg.DevMode
	s.assetsFromDisk = cfg.AssetsFromDisk
	s.bootProjectPath = cfg.ProjectPath
	s.extraRoutes = cfg.ExtraRoutes
	s.exitWithParent = cfg.ExitWithParent
	s.loopbackOnly = cfg.LoopbackOnly
	s.ingressSecret = cfg.IngressSecret
	s.staticVersion = staticVersion
	s.apiToken = mintAPIToken()
	s.bootID = generateClientID()
	s.startTime = time.Now()
	s.shutdownChan = make(chan struct{})
	s.workerManager = wm
	s.conversationCache = newConversationCache(s.ProjectPath)
	s.refreshRequests = make(chan struct{}, 1)
	s.providersReady = make(chan struct{})
	s.quickCompleteSem = make(chan struct{}, quickCompleteConcurrency)
	s.switchToken = make(chan struct{}, 1)
	s.switchToken <- struct{}{}

	s.stats = newWSStats()

	// Load (or mint on first run) this project's persistent WebRTC identity so
	// peer connections present a stable DTLS fingerprint across restarts. Scoped
	// per project (stored 0600 in <project>/.juggler, like the instance lock), so
	// the several servers a user runs — one per project — each keep their own
	// pinnable identity rather than colliding on a machine-wide one. Anchored to
	// the launch project, matching how BootLock is keyed; a mid-session
	// SwitchProject does not re-key it. Best-effort: with no project (window
	// mode) or on any failure, webrtcCert stays nil and pion mints an ephemeral
	// per-connection certificate, exactly as before persistence existed.
	if cfg.ProjectPath != "" {
		if cert, err := loadOrCreateWebRTCCertificate(webRTCIdentityPath(cfg.ProjectPath)); err != nil {
			jlog.Info("WebRTC identity unavailable, using ephemeral certificates: %v", err)
		} else {
			s.webrtcCert = cert
		}
	}

	s.seedProjectState(cfg)

	s.hub = newClientHub()
	s.settings = newSettingsStore()
	s.updateChecker = s.newUpdateChecker()

	if err := s.loadIndexTemplate(); err != nil {
		return nil, fmt.Errorf("failed to load index template: %w", err)
	}

	// First, so the LAN gate, the API auth and every handler after them see a
	// caller the supervisor vouched for as remote ingress.
	s.router.Use(s.supervisorIngressMiddleware)
	s.router.Use(s.lanGateMiddleware)
	s.router.Use(s.pageHostMiddleware)
	s.router.Use(s.apiAuthMiddleware)

	s.setupSessionRoutes(sessionAPI)
	s.setupConfigRoutes(configAPI)
	s.setupConnectivityRoutes()
	s.setupLogsRoutes()
	s.setupProjectRoutes()
	s.setupRoutes()

	s.wireWorkerManager()
	go s.runProviderRefreshActor()

	return s, nil
}
