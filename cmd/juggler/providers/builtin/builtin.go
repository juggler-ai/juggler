//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package builtin is the one list of the model providers Juggler ships. The
// server registers all of them at startup (app.registerProviders) and the
// catalog audit (providers/audit) those with a static catalog, so a provider
// added here reaches both, and TestAllCoversEveryProviderPackage fails for one
// that is not.
package builtin

import (
	"juggler/cmd/juggler/providers/acp"
	"juggler/cmd/juggler/providers/anthropic"
	"juggler/cmd/juggler/providers/claudecode"
	"juggler/cmd/juggler/providers/copilot"
	"juggler/cmd/juggler/providers/deepseek"
	"juggler/cmd/juggler/providers/gemini"
	"juggler/cmd/juggler/providers/jev"
	"juggler/cmd/juggler/providers/llamacpp"
	"juggler/cmd/juggler/providers/lmstudio"
	"juggler/cmd/juggler/providers/localai"
	"juggler/cmd/juggler/providers/mistral"
	"juggler/cmd/juggler/providers/moonshot"
	"juggler/cmd/juggler/providers/ollama"
	"juggler/cmd/juggler/providers/openai"
	"juggler/cmd/juggler/providers/openaicodex"
	"juggler/cmd/juggler/providers/opencodezen"
	"juggler/cmd/juggler/providers/openrouter"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/zai"
)

// Provider is one built-in provider.
type Provider struct {
	// Name is the name it registers under: its type, and its default account.
	Name string
	// Register adds it to the global provider registry.
	Register func()
	// Catalog says it ships a static model catalog of its own, which the
	// catalog audit holds to account. The CLI- and protocol-backed providers
	// do not: their models come from a subprocess.
	Catalog bool
	// Category is where its type sits in the "Add account" menu. Empty for a
	// provider that is not an account type at all: ACP's agents are models of
	// one provider, configured per project.
	Category provider.Category
	// Accounts gives its type what further accounts need beyond the default
	// for its category, when it takes them (a CLI's config folder, a login's
	// host). Nil for a type that has nothing of its own.
	Accounts func(*provider.TypeInfo)
}

// All is every built-in provider, in registration order.
var All = []Provider{
	{Name: "acp", Register: acp.Register, Catalog: false},
	{Name: "anthropic", Register: anthropic.Register, Catalog: true, Category: provider.CategoryAPIKey},
	{Name: claudecode.TypeName, Register: claudecode.Register, Catalog: false, Category: provider.CategorySubscription, Accounts: claudecode.AccountType},
	{Name: copilot.TypeName, Register: copilot.Register, Catalog: true, Category: provider.CategorySubscription, Accounts: copilot.AccountType},
	{Name: "deepseek", Register: deepseek.Register, Catalog: true, Category: provider.CategoryAPIKey},
	{Name: "gemini", Register: gemini.Register, Catalog: true, Category: provider.CategoryAPIKey},
	{Name: "jev", Register: jev.Register, Catalog: true, Category: provider.CategoryAPIKey},
	{Name: "llamacpp", Register: llamacpp.Register, Catalog: true, Category: provider.CategoryLocal},
	{Name: "lmstudio", Register: lmstudio.Register, Catalog: true, Category: provider.CategoryLocal},
	{Name: "localai", Register: localai.Register, Catalog: true, Category: provider.CategoryLocal},
	{Name: "mistral", Register: mistral.Register, Catalog: true, Category: provider.CategoryAPIKey},
	{Name: "moonshot", Register: moonshot.Register, Catalog: true, Category: provider.CategoryAPIKey},
	{Name: "ollama", Register: ollama.Register, Catalog: true, Category: provider.CategoryLocal},
	{Name: "openai", Register: openai.Register, Catalog: true, Category: provider.CategoryAPIKey},
	{Name: openaicodex.TypeName, Register: openaicodex.Register, Catalog: true, Category: provider.CategorySubscription, Accounts: openaicodex.AccountType},
	{Name: "opencodezen", Register: opencodezen.Register, Catalog: true, Category: provider.CategoryAPIKey},
	{Name: "openrouter", Register: openrouter.Register, Catalog: true, Category: provider.CategoryAPIKey},
	{Name: "zai", Register: zai.Register, Catalog: true, Category: provider.CategoryAPIKey},
}

// Register registers every built-in provider with the global registry, and
// records each one's type. Each registers its own default account, under the
// type's bare name, and is left exactly as its package registered it; the type
// record is what the settings page offers and what accounts.json entries name.
func Register() {
	for _, p := range All {
		p.Register()
		if p.Category == "" {
			continue
		}
		info, ok := provider.GetProviderInfo(p.Name)
		if !ok {
			continue
		}
		t := provider.TypeInfo{
			Name:              p.Name,
			DisplayName:       info.DisplayName,
			Description:       info.Description,
			Category:          p.Category,
			HasDefaultAccount: true,
		}
		// A further key is the whole of a further account of an API-key type.
		if p.Category == provider.CategoryAPIKey {
			t.Instantiate = provider.InstantiateAPIKeyAccount
			t.KeySlot = provider.AccountKeySlot
		}
		if p.Accounts != nil {
			p.Accounts(&t)
		}
		provider.RegisterType(t)
	}
}
