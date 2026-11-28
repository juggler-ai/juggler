module juggler

go 1.27.0

require (
	github.com/anthropics/anthropic-sdk-go v1.84.0
	github.com/bmatcuk/doublestar/v4 v4.10.7
	github.com/buger/jsonparser v1.6.1
	github.com/fsnotify/fsnotify v1.10.1
	github.com/godbus/dbus/v5 v5.2.4
	github.com/gofrs/flock v0.13.2
	github.com/gorilla/mux v1.8.1
	github.com/gorilla/websocket v1.5.3
	github.com/laurent22/go-trash v0.0.0-20250304161307-725f51160fe4
	github.com/mattn/go-ieproxy v0.0.12
	github.com/mattn/go-isatty v0.0.24
	github.com/modelcontextprotocol/go-sdk v1.8.0
	github.com/openai/openai-go/v3 v3.108.0
	github.com/pion/logging v0.2.4
	github.com/pion/mdns/v2 v2.2.2
	github.com/pion/webrtc/v4 v4.2.29
	github.com/skyterra/y-crdt v0.0.0-20260605035931-e8e6d95bd5ff
	github.com/wailsapp/wails/v3 v3.2.0-nightly.20261123
	golang.org/x/image v0.48.0
	golang.org/x/net v0.63.0
	golang.org/x/sys v0.50.0
	golang.org/x/term v0.48.0
	golang.org/x/text v0.44.0
	google.golang.org/genai v1.79.1
	rsc.io/qr v0.2.0
)

require (
	cloud.google.com/go v0.123.0 // indirect
	cloud.google.com/go/auth v0.24.5 // indirect
	cloud.google.com/go/compute/metadata v0.10.0 // indirect
	github.com/bahlo/generic-list-go v0.2.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/coder/websocket v1.8.15 // indirect
	github.com/ebitengine/purego v0.11.3 // indirect
	github.com/felixge/httpsnoop v1.1.0 // indirect
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/google/jsonschema-go v0.4.3 // indirect
	github.com/google/s2a-go v0.1.11 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/googleapis/enterprise-certificate-proxy v0.3.25 // indirect
	github.com/googleapis/gax-go/v2 v2.27.0 // indirect
	github.com/invopop/jsonschema v0.14.0 // indirect
	github.com/mitchellh/copystructure v1.2.0 // indirect
	github.com/mitchellh/reflectwalk v1.0.2 // indirect
	github.com/pb33f/go-yaml v0.2.0 // indirect
	github.com/pb33f/ordered-map/v2 v2.3.2 // indirect
	github.com/pion/datachannel v1.6.4 // indirect
	github.com/pion/dtls/v3 v3.1.16 // indirect
	github.com/pion/ice/v4 v4.4.9 // indirect
	github.com/pion/interceptor v0.1.51 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/rtcp v1.2.20 // indirect
	github.com/pion/rtp v1.10.6 // indirect
	github.com/pion/sctp v1.12.2 // indirect
	github.com/pion/sdp/v3 v3.0.20 // indirect
	github.com/pion/srtp/v3 v3.1.3 // indirect
	github.com/pion/stun/v4 v4.0.1 // indirect
	github.com/pion/transport/v5 v5.1.6 // indirect
	github.com/pion/turn/v5 v5.1.3 // indirect
	github.com/segmentio/asm v1.2.1 // indirect
	github.com/segmentio/encoding v0.5.4 // indirect
	github.com/standard-webhooks/standard-webhooks/libraries v1.3.0 // indirect
	github.com/tidwall/gjson v1.20.7 // indirect
	github.com/tidwall/match v1.2.0 // indirect
	github.com/tidwall/pretty v1.3.1 // indirect
	github.com/tidwall/sjson v1.2.11 // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	go.opentelemetry.io/auto/sdk v1.2.2 // indirect
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.72.0 // indirect
	go.opentelemetry.io/otel v1.47.0 // indirect
	go.opentelemetry.io/otel/log v1.47.0 // indirect
	go.opentelemetry.io/otel/metric v1.47.0 // indirect
	go.opentelemetry.io/otel/trace v1.47.0 // indirect
	golang.org/x/crypto v0.59.0 // indirect
	golang.org/x/oauth2 v0.38.0 // indirect
	golang.org/x/sync v0.25.0 // indirect
	golang.org/x/time v0.16.0 // indirect
	google.golang.org/api v0.317.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20261123191846-1e707ab9fbc2 // indirect
	google.golang.org/grpc v1.85.0 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

replace github.com/wailsapp/wails/v3 => ./3rdparty/wails/v3

// fsnotify v1.10.1 plus one fix: on Windows, Close can wait forever when an
// error is being delivered as it arrives. docs/fsnotify-fork.md has the patch
// and when to drop it.
replace github.com/fsnotify/fsnotify => ./3rdparty/fsnotify

// genai v1.79.1 without its test-only replay client, which every importer
// otherwise links and which stops the linker pruning unused methods.
// docs/genai-fork.md has the patch and when to drop it.
replace google.golang.org/genai => ./3rdparty/genai
