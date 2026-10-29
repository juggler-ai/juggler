//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import (
	"context"
	"slices"
	"sync"

	"juggler/cmd/juggler/providers/openaibase"
)

// Thinking control travels as reasoning_effort on Ollama's OpenAI-compatible
// /v1 endpoint, which converts it to the native `think` value: "none" turns
// thinking off, and a level the model's own metadata names is passed through
// verbatim. A model without the "thinking" capability rejects any effort but
// "none" with a 400, so such a model is offered no control at all.

// thinkingCapability is the /api/show capabilities entry of a model that can think.
const thinkingCapability = "thinking"

// offLevel is the reasoning_effort Ollama maps to `think: false`.
const offLevel = "none"

// onLevel stands for `think: true` on a model whose metadata offers only an
// on/off switch: Ollama maps every recognised effort to true there, and
// "medium" is the level it reports for a bare true.
const onLevel = "medium"

// legacyLevels are offered to a thinking model on a daemon that reports the
// capability but no per-model metadata: the efforts such a daemon validates,
// with no declared default to label.
var legacyLevels = []string{offLevel, "low", "medium", "high"}

// thinkingDescriptor is /api/show's per-model "thinking" object: the controls
// the model accepts (booleans or named levels) and the one used on omission.
type thinkingDescriptor struct {
	Values  []any `json:"values"`
	Default any   `json:"default"`
}

// thinkingSpecFromShow derives a model's thinking levels from its /api/show
// capabilities and thinking metadata. Fewer than two levels is no choice, so
// an always-on model gets no control either.
func thinkingSpecFromShow(capabilities []string, thinking *thinkingDescriptor) openaibase.ThinkingSpec {
	if !slices.Contains(capabilities, thinkingCapability) {
		return openaibase.ThinkingSpec{}
	}
	if thinking == nil || len(thinking.Values) == 0 {
		return openaibase.EffortSpec("", legacyLevels...)
	}
	var canOff, canOn bool
	var named []string
	for _, value := range thinking.Values {
		switch v := value.(type) {
		case bool:
			canOff = canOff || !v
			canOn = canOn || v
		case string:
			if v != "" && !slices.Contains(named, v) {
				named = append(named, v)
			}
		}
	}
	var levels []string
	if canOff && !slices.Contains(named, offLevel) {
		levels = append(levels, offLevel)
	}
	switch {
	case len(named) > 0:
		levels = append(levels, named...)
	case canOn:
		levels = append(levels, onLevel)
	}
	if len(levels) < 2 {
		return openaibase.ThinkingSpec{}
	}
	return openaibase.EffortSpec(thinkingDefault(thinking.Default, levels, len(named) > 0), levels...)
}

// thinkingDefault names the advertised level matching the model's declared
// default, or "" when none does. A default of true only has a name when the
// metadata is a bare on/off switch.
func thinkingDefault(declared any, levels []string, named bool) string {
	var level string
	switch d := declared.(type) {
	case string:
		level = d
	case bool:
		switch {
		case !d:
			level = offLevel
		case !named:
			level = onLevel
		}
	}
	if !slices.Contains(levels, level) {
		return ""
	}
	return level
}

// thinkingSpecs maps each model name to its openaibase.ThinkingSpec as last
// read from /api/show, so a client built for a model reuses what listModels
// already probed.
var thinkingSpecs sync.Map

func rememberThinkingSpec(model string, spec openaibase.ThinkingSpec) {
	thinkingSpecs.Store(model, spec)
}

// thinkingSpec is the descriptor's ThinkingSpecFn. A model listModels has not
// covered (a client restored before the first list) is probed directly, so its
// chosen level still reaches the wire; a failed probe is not remembered, and
// the next client retries it.
func thinkingSpec(model string) openaibase.ThinkingSpec {
	if cached, ok := thinkingSpecs.Load(model); ok {
		if spec, ok := cached.(openaibase.ThinkingSpec); ok {
			return spec
		}
	}
	show, err := probeShow(context.Background(), model, nil)
	if err != nil {
		return openaibase.ThinkingSpec{}
	}
	spec := thinkingSpecFromShow(show.Capabilities, show.Thinking)
	rememberThinkingSpec(model, spec)
	return spec
}
