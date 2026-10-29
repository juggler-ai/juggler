//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package i18nextract

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"golang.org/x/text/language"

	"juggler/cmd/juggler/msg"
)

// TranslationProblem is one way a translation catalogue is wrong.
type TranslationProblem struct {
	// Key is the entry it is in; nil for a problem with the file as a whole.
	Key *string
	// Kind names the rule broken: json, not-object, locale, not-string, stale,
	// or one of msg.TranslationProblem's.
	Kind string
	// Message says what is wrong, worded as scripts/i18n words it.
	Message string
}

// CheckTranslation holds a translation file to its catalogue, as
// translationProblems() in scripts/i18n does, in the same order and words:
// problems with the file as a whole, then each entry's, in key order. source
// maps each catalogue key to its English; data is the file; locale its name.
// An empty value is untranslated and passes.
func CheckTranslation(source map[string]string, data []byte, locale string) []TranslationProblem {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return []TranslationProblem{{Kind: "json", Message: "does not parse as JSON"}}
	}
	catalog, ok := value.(map[string]any)
	if !ok {
		return []TranslationProblem{{Kind: "not-object", Message: "is not a JSON object mapping each English source to its translation"}}
	}
	var out []TranslationProblem
	categories := PluralCategories(locale)
	if categories == nil {
		out = append(out, TranslationProblem{Kind: "locale",
			Message: fmt.Sprintf(`"%s" is not a locale with plural rules — name the file after one, such as fr or pt-BR`, locale)})
	}
	keys := make([]string, 0, len(catalog))
	for k := range catalog {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
	for _, key := range keys {
		s, ok := catalog[key].(string)
		switch {
		case !ok:
			out = append(out, TranslationProblem{Key: &key, Kind: "not-string", Message: "the translation is not a string"})
			continue
		case s == "":
			continue
		}
		english, ok := source[key]
		if !ok {
			out = append(out, TranslationProblem{Key: &key, Kind: "stale",
				Message: "not in en.json — the English changed or was removed; retranslate it under the current English, then delete this entry"})
			continue
		}
		for _, p := range msg.CheckTranslation(english, s, locale, categories) {
			out = append(out, TranslationProblem{Key: &key, Kind: p.Kind, Message: p.Message})
		}
	}
	return out
}

// pluralOrder is the CLDR plural categories in the order messages list them;
// scripts/i18n's PLURAL_ORDER is the same list.
var pluralOrder = []string{"zero", "one", "two", "few", "many", "other"}

// pluralCategoriesFile is the table PluralCategories reads: each two- and
// three-letter language Node's Intl.PluralRules supports, and its categories
// in pluralOrder. It is generated from Intl, which scripts/i18n asks
// directly, because golang.org/x/text's plural data is an older CLDR (French
// has no `many` there); TestPluralCategoriesMatchIntl keeps it current.
const pluralCategoriesFile = "plural_categories.json"

//go:embed plural_categories.json
var pluralCategoriesJSON []byte

var pluralTable = sync.OnceValue(func() map[string][]string {
	var table map[string][]string
	if err := json.Unmarshal(pluralCategoriesJSON, &table); err != nil {
		panic(fmt.Sprintf("i18nextract: %s: %v", pluralCategoriesFile, err))
	}
	return table
})

// PluralCategories is the plural categories of locale, as
// Intl.PluralRules(locale).resolvedOptions().pluralCategories gives them but
// in pluralOrder, or
// nil for a tag that is not BCP 47 or a language with no plural rules. A
// region or script takes its language's categories.
func PluralCategories(locale string) []string {
	if strings.Contains(locale, "_") {
		return nil
	}
	if _, err := language.Parse(locale); err != nil {
		return nil
	}
	lang, _, _ := strings.Cut(locale, "-")
	return pluralTable()[strings.ToLower(lang)]
}
