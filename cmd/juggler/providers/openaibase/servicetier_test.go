//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

func priorityTierSpec() ServiceTierSpec {
	return ServiceTierSpec{Tiers: []provider.ServiceTier{{
		ID:          "priority",
		Name:        "Fast",
		Description: "1.5x speed, increased usage",
	}}}
}

// TestTierForGatesOnAdvertisedList pins the wire gate: the advertised list is
// the only authority. An id the model never offered must be dropped rather than
// sent, because a tier the backend rejects is a hard 400 and a tier it accepts
// costs real money.
func TestTierForGatesOnAdvertisedList(t *testing.T) {
	spec := priorityTierSpec()

	cases := []struct {
		name    string
		id      string
		want    string
		wantOK  bool
		comment string
	}{
		{name: "advertised", id: "priority", want: "priority", wantOK: true},
		{name: "empty means standard", id: "", wantOK: false},
		{name: "unadvertised", id: "flex", wantOK: false},
		{name: "wrong case is not a match", id: "Priority", wantOK: false},
		{name: "catalog label is not an id", id: "Fast", wantOK: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := spec.tierFor(tc.id)
			if ok != tc.wantOK || got != tc.want {
				t.Fatalf("tierFor(%q) = (%q, %v), want (%q, %v)", tc.id, got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

// TestZeroSpecSendsNothing covers the overwhelming majority of models: a vendor
// with a single serving speed must produce a request byte-identical to one from
// before the feature existed.
func TestZeroSpecSendsNothing(t *testing.T) {
	var spec ServiceTierSpec

	if len(spec.Options()) != 0 {
		t.Fatalf("zero spec advertised tiers: %+v", spec.Options())
	}
	for _, id := range []string{"", "priority", "flex", "auto"} {
		if got, ok := spec.tierFor(id); ok {
			t.Fatalf("zero spec admitted %q as %q, want no tier on the wire", id, got)
		}
	}
}

// TestDefaultTierIsNeverAppliedForTheCaller is the money guard. The catalog's
// declared default is presentation only: a tier bills at a multiple of standard
// rates, so it rides only on an explicit human choice. A default that leaked
// into tierFor would silently spend on every turn.
func TestDefaultTierIsNeverAppliedForTheCaller(t *testing.T) {
	spec := ServiceTierSpec{
		Tiers:   []provider.ServiceTier{{ID: "priority", Name: "Fast"}},
		Default: "priority",
	}

	if spec.Default != "priority" {
		t.Fatalf("Default = %q, want the catalog value preserved for display", spec.Default)
	}
	if got, ok := spec.tierFor(""); ok {
		t.Fatalf("absent tier resolved to %q via the catalog default, want standard serving", got)
	}
}

// TestOptionsPreserveCatalogOrder keeps display order the provider's decision —
// the UI renders Options() verbatim and must not have to sort or relabel.
func TestOptionsPreserveCatalogOrder(t *testing.T) {
	spec := ServiceTierSpec{Tiers: []provider.ServiceTier{
		{ID: "flex", Name: "Flex"},
		{ID: "priority", Name: "Fast", Description: "1.5x speed, increased usage"},
	}}

	opts := spec.Options()
	if len(opts) != 2 || opts[0].ID != "flex" || opts[1].ID != "priority" {
		t.Fatalf("Options() = %+v, want catalog order [flex priority]", opts)
	}
	if opts[1].Name != "Fast" || opts[1].Description != "1.5x speed, increased usage" {
		t.Fatalf("provider's own label/blurb not preserved: %+v", opts[1])
	}
}
