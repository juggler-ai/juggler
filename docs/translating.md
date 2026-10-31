# Translating Juggler

Juggler's interface can be shown in other languages. English is the source and
the fallback: any message without a translation shows in English, so a
translation can be added a piece at a time.

What the model reads is never translated. That covers tool descriptions,
prompts and tool results. The model answers in the language you write to it in
either way.

## Where the text lives

| Catalogue | What it covers |
|---|---|
| `web/i18n/<locale>.json` | The app: the web UI, the server's messages, the desktop menus and dialogs, and the installers' text |
| `web/extensions/<extension>/i18n/<locale>.json` | One built-in extension's own text (`juggler-core` holds most tools and pins) |

Each catalogue directory holds:
- `en.json`: the source list, one entry per message;
- `en-XA.json`: a generated pseudo-locale;
- one `<locale>.json` per language.

Never edit `en.json` or `en-XA.json` by hand. `node scripts/i18n extract`
writes them.

A file's name is its language tag: `fr.json`, `pt-BR.json`, `zh-Hant.json`.
Lookup falls back message by message along the tag. For `fr-CA`, a message
missing from `fr-CA.json` comes from `fr.json`, then shows in English.

## The format

A flat JSON object. The key is the English, exactly as in `en.json`, and the
value is the translation:

```json
{
  "Search results": "Résultats de la recherche",
  "{count, plural, one {# match} other {# matches}}": "{count, plural, one {# résultat} many {# de résultats} other {# résultats}}",
  "door\u0004Open": "Ouvrir"
}
```

**Placeholders.** `{name}` is replaced by a value. Keep every placeholder the
English has, and add none. You may move them anywhere in the sentence.

**Plurals.** `{count, plural, …}` chooses a branch by number. Use your
language's plural categories (`zero`, `one`, `two`, `few`, `many`, `other`) or
exact values such as `=0`. Inside a branch, `#` is the number. Every plural
needs an `other` branch.

**Selects.** `{x, select, a {…} other {…}}` chooses a phrase. Keep the English
branch names and translate their contents.

**Apostrophes.** An apostrophe is literal text. Write `'{'` only when you need
a literal brace.

**Contexts.** A key of the form `context\u0004English` is one meaning of an
English word that has several (`door\u0004Open`). Translate the meaning the
context names.

**Markup.** Never add HTML. A link or emphasis inside a sentence is a
placeholder such as `{docs}`, and its own text is a separate message.

**Untranslated messages.** Leave a message out, or set it to `""`, and it shows
in English.

## Checking a translation

From the repository root:

```bash
node scripts/i18n check    # fails on any broken translation, naming the file and key
node scripts/i18n status   # how much of each language is translated
node scripts/i18n coverage # fails unless every language is translated in full
node scripts/i18n extract  # after the source changes: lists keys whose English is gone
```

`check` runs with the rest of the lint (`make lint`). It refuses a translation
that:
- doesn't parse;
- adds or drops a placeholder;
- lacks an `other` branch;
- uses a plural category the language doesn't have;
- adds HTML;
- has a key that is no longer in `en.json`.

The last case means the English was reworded: translate the new English, then
delete the old entry.

To see the result, choose the language under Settings → Language.
Look for:
- **English left on screen:** a message that isn't in your file yet;
- **clipped or overflowing text:** a layout that needs attention.

With Juggler run with `--dev`, the same menu also offers the pseudo-locale
`en-XA`, which shows every translatable message accented and padded. Use it to
check that nothing is missed.

## What follows automatically

Adding `<locale>.json` is the whole change. Nothing else needs editing:
- **The Language menu** lists every language that has a file in `web/i18n`, by
  its own name (Français, Deutsch), whatever language the app is in.
- **Other open windows** switch once they're idle.
- **The desktop menus and dialogs** follow the chosen language.
- **The macOS app** declares the language.
- **The Windows installer** offers it, provided Inno Setup ships that language.

## Extensions

A third-party extension ships its own catalogues. See *Translating your
extension* in `docs/extension_guide.md`. `juggler ext i18n` extracts and
checks them the same way.
