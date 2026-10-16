import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  MarkdownProps,
  RenderElement,
  TextProps,
} from 'claude-code'

import type {
  OsmosisProgress,
  OsmosisQuiz,
  OsmosisRecentWord,
  OsmosisSettings,
  OsmosisWord,
} from '../types'
import { cellWidth, langInfo, scopeFor, shownText } from './core'
import type { Part, Segment, Token } from './core'

export type Els = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Markdown: ElementConstructor<MarkdownProps>
}

export const LEARN_COLOR = 'suggestion'
const BULLET = '⏺'

function drawPart({ Text }: Els, p: Part) {
  if (p.kind === 'bold') return <Text bold>{p.text}</Text>
  if (p.kind === 'italic') return <Text italic>{p.text}</Text>
  if (p.kind === 'code') return <Text color="permission">{p.text}</Text>
  if (p.kind === 'link' || p.kind === 'url') return <Text color="suggestion" underline>{p.text}</Text>
  return p.text
}

function drawWord(els: Els, w: OsmosisWord, scope: string, s: OsmosisSettings, key: string, onPress: () => void) {
  const { Button, Text } = els
  const shown = shownText(w, s.show)
  return (
    <Button key={key} label={`${shown} (${w.en})`} plain hover={{ scope, inverse: true }} onPress={onPress}>
      <Text color={LEARN_COLOR} underline>{shown}</Text>
      {s.show === 'both' && w.romanization ? <Text dimColor> {w.romanization}</Text> : null}
    </Button>
  )
}

function drawToken(els: Els, t: Token, words: readonly OsmosisWord[], msgKey: string, s: OsmosisSettings, pick: (i: number) => void) {
  const { Box, Text } = els
  if (t.kind === 'swap') {
    const w = words[t.index]!
    return (
      <Box flexDirection="row" flexShrink={0}>
        {drawWord(els, w, scopeFor(msgKey, t.index), s, `w-${t.index}`, () => pick(t.index))}
        {t.trailing ? <Text>{t.trailing}</Text> : null}
      </Box>
    )
  }
  if (t.parts.length === 1 && t.parts[0]!.kind === 'text') return <Text>{t.parts[0]!.text}</Text>
  return <Text>{t.parts.map(p => drawPart(els, p))}</Text>
}

export function drawMessage(
  els: Els,
  segs: Segment[],
  words: readonly OsmosisWord[],
  msgKey: string,
  isFirst: boolean,
  s: OsmosisSettings,
  pick: (i: number) => void,
): RenderElement {
  const { Box, Text, Markdown } = els
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2} flexShrink={0}>
        <Text color="text">{isFirst ? BULLET : ' '}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
        {segs.map(seg =>
          seg.kind === 'md' ? (
            <Markdown text={seg.text} />
          ) : (
            <Box flexDirection="column">
              {seg.lines.map(line => (
                <Box flexDirection="row" paddingLeft={line.indent}>
                  {line.marker !== null ? (
                    <Box flexShrink={0}>
                      <Text>{`${line.marker} `}</Text>
                    </Box>
                  ) : null}
                  <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1}>
                    {line.tokens.map(t => drawToken(els, t, words, msgKey, s, pick))}
                  </Box>
                </Box>
              ))}
            </Box>
          ),
        )}
      </Box>
    </Box>
  ) as RenderElement
}

// ---------- the band ----------

function cut(s: string, cells: number): string {
  if (cellWidth(s) <= cells) return s
  let out = ''
  for (const ch of s) {
    if (cellWidth(out + ch) > cells - 1) break
    out += ch
  }
  return out + '…'
}

export function cardLine(w: OsmosisWord): { head: string; rest: string } {
  const bits = [w.pos, w.gloss].filter(Boolean).join('  ')
  const tail = [w.literal, w.level ? `HSK ${w.level}` : '', 'click for more'].filter(Boolean).join(' · ')
  return { head: w.target, rest: ` ${w.romanization}  ${bits}  · ${tail}  ` }
}

export function drawBand(
  els: Els,
  recent: readonly OsmosisRecentWord[],
  s: OsmosisSettings,
  todayCount: number,
  columns: number,
): RenderElement {
  const { Box, Text } = els
  const info = langInfo(s.lang)
  const compact = `Osmosis ${info.label} · ${s.level} · ${todayCount} words today · /osmosis`
  return (
    <Box flexDirection="row">
      <Box flexDirection="row" flexShrink={0}>
        {recent.map(r => {
          const { head, rest } = cardLine(r.word)
          const room = Math.max(10, columns - cellWidth(head) - 2)
          return (
            <Box display="none" hover={{ scope: scopeFor(r.key, r.index), display: 'flex' }} flexShrink={0}>
              <Text wrap="truncate-end">
                <Text bold color={LEARN_COLOR}>{head}</Text>
                <Text>{cut(rest, room)}</Text>
              </Text>
            </Box>
          )
        })}
      </Box>
      <Text dimColor wrap="truncate-end">{compact}</Text>
    </Box>
  ) as RenderElement
}

// ---------- the pane ----------

export type PaneActions = {
  speak: (w: OsmosisWord) => void
  toggleSave: (w: OsmosisWord) => void
  toggleKnown: (w: OsmosisWord) => void
  step: (delta: number) => void
  pick: (i: number) => void
  close: () => void
  home: () => void
  unsave: (target: string) => void
  answer: (choice: number) => void
  retake: () => void
  setSettings: (patch: Partial<OsmosisSettings>) => void
  openView: (view: 'bank' | 'quiz') => void
}

function choiceRow<V extends string>(
  { Box, Text, Button }: Els,
  title: string,
  name: string,
  options: readonly (readonly [V, string])[],
  current: V,
  choose: (v: V) => void,
  hotkeyFor?: (v: V) => string | undefined,
) {
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Box minWidth={11} flexShrink={0}>
        <Text dimColor>{title}</Text>
      </Box>
      {options.map(([value, label]) => {
        const hotkey = hotkeyFor?.(value)
        return hotkey === undefined ? (
          <Button key={`${name}-${value}`} label={label} variant={value === current ? 'primary' : 'secondary'} onPress={() => choose(value)} />
        ) : (
          <Button key={`${name}-${value}`} label={label} hotkey={hotkey} variant={value === current ? 'primary' : 'secondary'} onPress={() => choose(value)} />
        )
      })}
    </Box>
  )
}

const ON_OFF = [['on', 'On'], ['off', 'Off']] as const
const LEVELS = [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']] as const
const DENSITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']] as const
const SHOWS = [['hanzi', 'Hanzi'], ['pinyin', 'Pinyin'], ['both', 'Both']] as const

export function drawSettings(els: Els, s: OsmosisSettings, act: PaneActions) {
  const { Box, Text, Button } = els
  const on = s.isOn ? 'on' : 'off'
  const bar = s.isBandOn ? 'on' : 'off'
  return (
    <Box flexDirection="column">
      <Text bold>Settings</Text>
      {choiceRow(els, 'Osmosis', 'set', ON_OFF, on, v => act.setSettings({ isOn: v === 'on' }), v => (v === on ? undefined : 'o'))}
      {choiceRow(els, 'Level', 'level', LEVELS, s.level, v => act.setSettings({ level: v }))}
      {choiceRow(els, 'Density', 'density', DENSITIES, s.density, v => act.setSettings({ density: v }))}
      {choiceRow(els, 'Show', 'show', SHOWS, s.show, v => act.setSettings({ show: v }))}
      {choiceRow(els, 'Hover bar', 'bar', ON_OFF, bar, v => act.setSettings({ isBandOn: v === 'on' }), v => (v === bar ? undefined : 'v'))}
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Button key="view-bank" label="Word bank" hotkey="w" onPress={() => act.openView('bank')} />
        <Button key="view-quiz" label="Quiz" hotkey="q" onPress={() => act.openView('quiz')} />
      </Box>
      <Text dimColor>{`o: on/off \u00b7 v: hover bar \u00b7 w: word bank \u00b7 q: quiz \u00b7 ${langInfo(s.lang).name}`}</Text>
    </Box>
  )
}

export function drawHome(
  els: Els,
  s: OsmosisSettings,
  words: readonly OsmosisWord[],
  selected: number | null,
  progress: OsmosisProgress,
  act: PaneActions,
): RenderElement {
  const { Box, Text, Button } = els
  const w = selected === null ? undefined : words[selected]
  const seen = w ? progress.seen[w.target]?.n ?? 0 : 0
  const isSaved = w ? progress.saved[w.target] !== undefined : false
  const isKnown = w ? progress.known[w.target] === true : false
  return (
    <Box flexDirection="column" gap={1}>
      {w ? (
        <Box flexDirection="column">
          <Text>
            <Text bold color={LEARN_COLOR}>{w.target}</Text>
            {`  ${w.romanization}  `}
            <Text dimColor>{[w.pos, w.level ? `HSK ${w.level}` : ''].filter(Boolean).join(' · ')}</Text>
          </Text>
          <Text>{w.gloss}</Text>
          {w.literal ? <Text dimColor>{w.literal}</Text> : null}
        </Box>
      ) : (
        <Text dimColor>Hover a highlighted word in a reply to peek; click it (or pick one below) for more.</Text>
      )}
      {w && w.exampleTarget ? (
        <Box flexDirection="column">
          <Text>{w.exampleTarget}</Text>
          {w.exampleRomanization ? <Text dimColor>{w.exampleRomanization}</Text> : null}
          {w.exampleEn ? <Text italic>{w.exampleEn}</Text> : null}
        </Box>
      ) : null}
      {w ? (
        <Text dimColor>
          {`English: "${w.en}" · seen ${seen}x${isSaved ? ' · saved' : ''}${isKnown ? ' · known' : ''}`}
        </Text>
      ) : null}
      {w ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="speak" hotkey="s" plain onPress={() => act.speak(w)}>Speak</Button>
          <Button key="save" hotkey="b" plain onPress={() => act.toggleSave(w)}>{isSaved ? 'Unsave' : 'Save to word bank'}</Button>
          <Button key="known" hotkey="k" plain onPress={() => act.toggleKnown(w)}>{isKnown ? 'Not known yet' : 'I know this'}</Button>
          <Button key="prev" hotkey="p" plain onPress={() => act.step(-1)}>Prev</Button>
          <Button key="next" hotkey="n" plain onPress={() => act.step(1)}>Next word</Button>
          <Button key="close" hotkey="x" plain onPress={act.close}>Close</Button>
        </Box>
      ) : (
        <Box flexDirection="row">
          <Button key="close" hotkey="x" plain onPress={act.close}>Close</Button>
        </Box>
      )}
      <Box flexDirection="column">
        <Text bold>{words.length ? "This reply's words" : 'No translated reply yet.'}</Text>
        {words.map((one, i) => (
          <Button key={`pick-${i}`} plain onPress={() => act.pick(i)}>
            {i === selected ? '› ' : '  '}
            <Text color={LEARN_COLOR}>{one.target}</Text>
            {` ${one.romanization} `}
            <Text dimColor>{one.gloss}</Text>
          </Button>
        ))}
      </Box>
      {drawSettings(els, s, act)}
    </Box>
  ) as RenderElement
}

export function drawBank(els: Els, progress: OsmosisProgress, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els
  const saved = Object.values(progress.saved)
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{`Word bank (${saved.length})`}</Text>
      {saved.length === 0 ? (
        <Text dimColor>No saved words yet. Click a word in a reply, then press b to save it.</Text>
      ) : (
        <Box flexDirection="column">
          {saved.map((w, i) => (
            <Box flexDirection="row" columnGap={1}>
              <Button key={`say-${i}`} plain dimColor onPress={() => act.speak(w)}>say</Button>
              <Button key={`unsave-${i}`} plain dimColor onPress={() => act.unsave(w.target)}>unsave</Button>
              <Text>
                <Text color={LEARN_COLOR}>{w.target}</Text>
                {` ${w.romanization} `}
                <Text dimColor>{w.gloss}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box flexDirection="row" columnGap={2}>
        <Button key="home" hotkey="h" plain onPress={act.home}>Back</Button>
        <Button key="close" hotkey="x" plain onPress={act.close}>Close</Button>
      </Box>
    </Box>
  ) as RenderElement
}

export function drawQuiz(els: Els, quiz: OsmosisQuiz | null, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els
  if (!quiz || quiz.questions.length === 0) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>Not enough words for a quiz yet. Read a few translated replies (or save words), then try /osmosis quiz again.</Text>
        <Box flexDirection="row" columnGap={2}>
          <Button key="home" hotkey="h" plain onPress={act.home}>Back</Button>
          <Button key="close" hotkey="x" plain onPress={act.close}>Close</Button>
        </Box>
      </Box>
    ) as RenderElement
  }
  const total = quiz.questions.length
  const q = quiz.questions[quiz.index]
  if (!q) {
    return (
      <Box flexDirection="column" gap={1}>
        {quiz.feedback ? <Text dimColor>{quiz.feedback}</Text> : null}
        <Text bold>{`Score: ${quiz.score} / ${total}`}</Text>
        <Box flexDirection="row" columnGap={2}>
          <Button key="retake" hotkey="r" plain onPress={act.retake}>New quiz</Button>
          <Button key="home" hotkey="h" plain onPress={act.home}>Back</Button>
          <Button key="close" hotkey="x" plain onPress={act.close}>Close</Button>
        </Box>
      </Box>
    ) as RenderElement
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>{`Question ${quiz.index + 1} of ${total} · score ${quiz.score}`}</Text>
      <Text>
        {'Which one means '}
        <Text bold>{`"${q.gloss}"`}</Text>
        {'?'}
      </Text>
      <Box flexDirection="column">
        {q.choices.map((c, i) => (
          <Button key={`choice-${i}`} hotkey={String(i + 1)} plain onPress={() => act.answer(i)}>{c}</Button>
        ))}
      </Box>
      {quiz.feedback ? <Text dimColor>{quiz.feedback}</Text> : null}
      <Box flexDirection="row" columnGap={2}>
        <Button key="close" hotkey="x" plain onPress={act.close}>Close</Button>
      </Box>
    </Box>
  ) as RenderElement
}
