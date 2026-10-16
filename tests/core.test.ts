import { describe, expect, test } from 'claude-code/testing'

import {
  eligibleRanges,
  isSwappable,
  keyFor,
  locate,
  parseReply,
  pickVoice,
  planMessage,
  splitBlocks,
  swapCap,
  DEFAULT_SETTINGS,
} from '../hooks/core'

const TEXT = [
  'I opened the computer and read the file. Then I wrote a short note for you.',
  '',
  '```ts',
  'const computer = 1',
  '',
  'note(computer)',
  '```',
  '',
  'Run `computer --help` or open src/computer.ts to see more.',
].join('\n')

const at = (text: string, needle: string, n = 1) => {
  let i = -1
  for (let k = 0; k < n; k++) i = text.indexOf(needle, i + 1)
  return i
}

const item = (en: string, occurrence: number, target: string) => ({
  en,
  occurrence,
  target,
  romanization: 'x',
  pos: 'noun',
  gloss: en,
  literal: '',
  example_target: '',
  example_romanization: '',
  example_en: '',
  level: 1,
})

const OPTS = { isMandarin: true, known: new Set<string>(), cap: 12 }

describe('block splitter', () => {
  test('a code fence with blank lines inside is one non-prose block', () => {
    const blocks = splitBlocks(TEXT)
    expect(blocks.map(b => b.isProse)).toEqual([true, false, true])
    expect(TEXT.slice(blocks[1]!.start, blocks[1]!.end)).toContain('note(computer)')
  })

  test('headings, quotes, tables and indented code are not prose', () => {
    const t = '# Title words here\n\n> quoted words\n\n| a | b |\n|---|---|\n\n    indented code\n\nPlain words here.'
    expect(splitBlocks(t).map(b => b.isProse)).toEqual([false, false, false, false, true])
  })

  test('bullet lists count as prose', () => {
    expect(splitBlocks('- first item\n- second item\n1. third item').map(b => b.isProse)).toEqual([true])
  })
})

describe('tokenizer and eligibility', () => {
  test('code fences, inline code and file paths never get swaps', () => {
    const ranges = eligibleRanges(TEXT)
    const inFence = at(TEXT, 'computer', 2)
    const inCode = at(TEXT, 'computer', 4)
    const inPath = at(TEXT, 'computer', 5)
    expect(isSwappable(TEXT, inFence, inFence + 8, ranges)).toBe(false)
    expect(isSwappable(TEXT, inCode, inCode + 8, ranges)).toBe(false)
    expect(isSwappable(TEXT, inPath, inPath + 8, ranges)).toBe(false)
    const prose = at(TEXT, 'computer', 1)
    expect(isSwappable(TEXT, prose, prose + 8, ranges)).toBe(true)
  })

  test('occurrence maps to the right substring', () => {
    const t = 'The cat sat down. A cat ran off. That category is new.'
    const r = eligibleRanges(t)
    expect(locate(t, 'cat', 1, r)).toBe(at(t, 'cat', 1))
    expect(locate(t, 'cat', 2, r)).toBe(at(t, 'cat', 2))
    expect(locate(t, 'cat', 3, r)).toBe(null)
  })

  test('an occurrence that points into inline code is dropped, never moved into code', () => {
    const t = 'Use `cat` here. The cat sleeps all day long.'
    const r = eligibleRanges(t)
    expect(locate(t, 'cat', 1, r)).toBe(null)
    expect(locate(t, 'cat', 2, r)).toBe(at(t, 'cat', 2))
  })

  test('identifiers, acronyms and partial words are refused', () => {
    const t = 'The fooBar helper and the API call help the reader a lot.'
    const r = eligibleRanges(t)
    expect(locate(t, 'fooBar', 1, r)).toBe(null)
    expect(locate(t, 'API', 1, r)).toBe(null)
    expect(locate(t, 'hel', 1, r)).toBe(null)
    expect(locate(t, 'reader', 1, r)).toBe(at(t, 'reader'))
  })
})

describe('model reply validation', () => {
  test('a good reply resolves offsets in order', () => {
    const reply = JSON.stringify([item('note', 1, '笔记'), item('computer', 1, '电脑')])
    const r = parseReply(reply, TEXT, OPTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.words.map(w => w.target)).toEqual(['电脑', '笔记'])
    expect(TEXT.slice(r.words[0]!.start, r.words[0]!.end)).toBe('computer')
    expect(r.words[0]!.start).toBe(at(TEXT, 'computer', 1))
  })

  test('a reply wrapped in a code fence with prose around it still parses', () => {
    const reply = 'Here you go:\n```json\n' + JSON.stringify([item('computer', 1, '电脑')]) + '\n```'
    const r = parseReply(reply, TEXT, OPTS)
    expect(r.ok && r.words.length).toBe(1)
  })

  test('a malformed reply fails', () => {
    expect(parseReply('[{"en": "computer", ', TEXT, OPTS).ok).toBe(false)
    expect(parseReply('no json here', TEXT, OPTS).ok).toBe(false)
  })

  test('a wrong substring, a missing hanzi or a code-only word is dropped', () => {
    const reply = JSON.stringify([
      item('keyboard', 1, '键盘'),
      item('opened', 1, 'opened'),
      item('Run', 1, '运行'),
      item('computer', 2, '电脑'),
      item('short', 1, '短'),
    ])
    const r = parseReply(reply, TEXT, OPTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.words.map(w => w.en)).toEqual(['short', 'Run'])
  })

  test('at most one known word per block, and the cap holds', () => {
    const reply = JSON.stringify([item('opened', 1, '打开'), item('read', 1, '读'), item('wrote', 1, '写'), item('note', 1, '笔记')])
    const r = parseReply(reply, TEXT, { isMandarin: true, known: new Set(['打开', '读']), cap: 2 })
    expect(r.ok && r.words.map(w => w.target)).toEqual(['打开', '写'])
  })
})

describe('planning a message', () => {
  test('code stays markdown; the prose block gets a swap token', () => {
    const r = parseReply(JSON.stringify([item('computer', 1, '电脑')]), TEXT, OPTS)
    if (!r.ok) throw new Error('parse failed')
    const segs = planMessage(TEXT, r.words)
    expect(segs.map(s => s.kind)).toEqual(['prose', 'md'])
    const md = segs[1]
    expect(md?.kind === 'md' && md.text.startsWith('```ts')).toBe(true)
    const prose = segs[0]
    if (prose?.kind !== 'prose') throw new Error('no prose')
    const swaps = prose.lines[0]!.tokens.filter(t => t.kind === 'swap')
    expect(swaps).toHaveLength(1)
  })

  test('the cache key changes with level, and density sets the cap', () => {
    expect(keyFor(TEXT, DEFAULT_SETTINGS)).not.toBe(keyFor(TEXT, { ...DEFAULT_SETTINGS, level: 'advanced' }))
    expect(swapCap('One. Two. Three. Four. Five. Six.', 'low')).toBe(2)
    expect(swapCap('One. Two. Three.', 'high')).toBe(6)
  })
})

describe('voice pick', () => {
  test('prefers Tingting, else the first zh_CN voice', () => {
    const flo = 'Flo (Chinese (China mainland)) zh_CN    # 你好！我叫Flo。'
    const ting = 'Tingting (Chinese (China mainland)) zh_CN    # 你好！我叫婷婷。'
    expect(pickVoice(['Samantha            en_US    # Hello', flo, ting].join('\n'))).toBe('Tingting')
    expect(pickVoice(['Samantha            en_US    # Hello', flo].join('\n'))).toBe('Flo (Chinese (China mainland))')
    expect(pickVoice('Samantha            en_US    # Hello')).toBe(undefined)
  })
})
