# Osmosis 中文

Osmosis is a Claude Code plugin that teaches you Mandarin while you work. It shows some English words in Claude's replies as Chinese characters, so you pick up vocabulary by osmosis while you read. The change is on your screen only. Claude never sees it, and the saved conversation does not change. Point at a Chinese word to see its meaning, or click it for a full card with pinyin, an example sentence, and a voice.

## Install

In a Claude Code terminal session:

```
/plugin install osmosis --marketplace raylrcheng/osmosis
```

Then type `y` to add the marketplace, and pick a scope.

From a shell:

```
claude plugin install osmosis --marketplace raylrcheng/osmosis
```

Requirements:

- Claude Code 2.1.275 or later.
- The fullscreen layout, for hover and click. Add `"tui": "fullscreen"` to your Claude Code settings.
- Osmosis calls Claude Haiku to pick and translate words. The calls run on your own Claude login.
- macOS for the Speak button, which uses the built-in `say` command. On other systems, Speak shows a message.

## How to use it

- Read a reply as usual. A few words show in Chinese, underlined and in color.
- Point at a Chinese word. A small card shows next to the word: the characters, pinyin, word type, meaning, a character-by-character breakdown, and the HSK level. The "Hover card" setting can move this card to the bar above the prompt.
- Click a Chinese word. A side pane opens with the full card, an example sentence, and buttons.
- In the pane, press these keys (click the pane first):
  - `s`: say the word and the example aloud in a Chinese voice.
  - `b`: save the word to your word bank, or remove it.
  - `k`: mark the word as known. Osmosis then shows it less often.
  - `n` / `p`: go to the next or the previous word of the same reply.
  - `x`: close the pane.
- The pane also lists all the Chinese words of the reply. Click one to open it.

A reply shows in English first. The Chinese words show a second or two later, when the translation is ready. Short replies, code, file paths, tables, and headings stay in English.

## Settings

Type `/osmosis` to open the pane. Its Settings section has a button for each choice, so you do not need to type anything:

- **Osmosis**: On or Off. Press `o` to switch.
- **Level**: Beginner (HSK 1-2), Intermediate (HSK 3-4), or Advanced (HSK 5-6, with idioms).
- **Density**: Low (about 1 word in 3 sentences), Normal (about 1 per sentence), or High (about 2 per sentence).
- **Show**: Hanzi (characters), Pinyin, or Both.
- **Hover card**: At the word (the default: the card shows next to the word you point at), In the bar (a one-line card in the bar above the prompt), or Both.
- **Hover bar**: On or Off. Press `v` to switch. Off hides the bar above the prompt, and its card too.
- **Word bank** (`w`) and **Quiz** (`q`) open those views.

Settings, saved words, and progress stay between sessions.

## Commands

The same settings also work as typed commands:

| Command | What it does |
|---|---|
| `/osmosis` | Opens the pane with the words of the latest reply and the settings. |
| `/osmosis on` / `/osmosis off` | Turns Osmosis on or off. Off shows all replies in plain English. |
| `/osmosis level beginner` | Sets the level: `beginner`, `intermediate`, or `advanced`. |
| `/osmosis density normal` | Sets the density: `low`, `normal`, or `high`. |
| `/osmosis show hanzi` | Sets how a word shows: `hanzi`, `pinyin`, or `both`. |
| `/osmosis card word` | Sets where the hover card shows: `word` (next to the word), `bar` (in the bar above the prompt), or `both`. |
| `/osmosis band on` / `/osmosis band off` | Shows or hides the hover bar above the prompt. |
| `/osmosis bank` | Opens your word bank. Each word has "say" and "unsave" buttons. |
| `/osmosis quiz` | Starts a 5-question quiz from your saved and recent words. Press `1`-`4` to answer. A word you get right 3 times becomes "known". |
| `/osmosis lang <name>` | Sets the language. Mandarin is the default and the tested language. |

The status line shows `🌱 中文 · <level>` while Osmosis is on.

## Good to know

- Each long reply costs one small Haiku call. Osmosis remembers old translations, so old replies show again at once.
- If a translation fails, the reply shows in plain English.
- A typed command prints one short line, for example "Osmosis level: beginner." Claude sees that line, as it sees any command output. The pane buttons print nothing.

## License

MIT. See [LICENSE](LICENSE).
