//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"juggler/cmd/juggler/providers/provider"
)

// ServiceTierSpec describes a model's non-standard serving classes. Each tier's
// ID IS the native service_tier string sent on the wire — there is no separate
// canonical vocabulary. The zero value (nil Tiers) means the model serves only
// at standard speed and the UI hides the selector.
//
// Standard serving is never a member: it is the absence of a tier, expressed as
// an empty MessageRequest.ServiceTier and an omitted wire field.
type ServiceTierSpec struct {
	// Tiers are the advertised serving classes in display order, carrying the
	// provider's own id, label and blurb.
	Tiers []provider.ServiceTier
	// Default names the tier the provider bills as this model's default
	// (presentation only). Deliberately never applied on the caller's behalf —
	// see tierFor.
	Default string
}

// ServiceTierSpecFunc returns the ServiceTierSpec for a model id. A nil func (or
// a zero ServiceTierSpec) means the provider exposes no speed control.
type ServiceTierSpecFunc func(modelID string) ServiceTierSpec

// tierFor returns the native service_tier to send for a requested tier id.
// ok=false means omit the service_tier param entirely — the id is absent or not
// one this model advertises — which preserves today's default request shape
// byte-for-byte. The advertised list is the only gate: an id is valid iff it is
// a member, and the string is sent verbatim.
//
// Spec.Default is deliberately NOT consulted. A tier is bought at a materially
// higher price, so it rides only on an explicit human choice; a catalog default
// must never spend on the caller's behalf.
func (s ServiceTierSpec) tierFor(id string) (string, bool) {
	if id == "" {
		return "", false
	}
	for _, tier := range s.Tiers {
		if tier.ID == id {
			return tier.ID, true
		}
	}
	return "", false
}

// Options returns the advertised service tiers in display order.
func (s ServiceTierSpec) Options() []provider.ServiceTier {
	return s.Tiers
}

// label returns the provider's own name for a tier id, falling back to the id
// itself so an unlabelled tier still reads as something rather than nothing.
func (s ServiceTierSpec) label(id string) string {
	for _, tier := range s.Tiers {
		if tier.ID == id && tier.Name != "" {
			return tier.Name
		}
	}
	return id
}

// serviceTierDowngrade compares the tier sent with the tier the backend says it
// served, returning a notice chunk when they differ.
//
// The comparison exists because the failure is silent: asking for a tier the
// account cannot use returns 200 with a different tier echoed back and no error
// of any kind, so without this the turn looks exactly like a successful one.
// Both empty cases are deliberate non-events — no tier was asked for, or the
// backend reported none and we will not invent a complaint from an absent field.
func (c *Client) serviceTierDowngrade(sent, served string) (provider.StreamChunk, bool) {
	if sent == "" || served == "" || served == sent {
		return provider.StreamChunk{}, false
	}
	name := c.serviceTierSpec.label(sent)
	// The lead names the tier the user chose and says plainly that they did not
	// get it. It stops at "a different tier" rather than naming standard speed:
	// the only thing known here is that the echo disagreed with what was sent,
	// and the served id is right below for anyone who needs it.
	lead := name + " was declined; " + c.providerName + " served this turn at a different tier and gave no reason."
	return provider.StreamChunk{
		Type: provider.ContentBlockTypeStatus,
		// Rides the spinner for the rest of the turn; the notice below is what
		// survives it.
		Content: name + " was declined",
		Metadata: map[string]any{
			"noticeSummary": lead,
			// The raw ids go in verbatim under the plain-English lead — they are
			// the only thing that makes an unexpected value diagnosable.
			"noticeContent": lead + "\n\nRequested: " + sent + "\nServed: " + served,
			"noticeSource":  c.providerName,
		},
	}, true
}
