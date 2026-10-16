import type {
  OsmosisDensity,
  OsmosisLevel,
  OsmosisProgress,
  OsmosisSettings,
  OsmosisWord,
} from '../types'

export const MIN_CHARS = 40
export const MAX_SWAPS = 12

export const DEFAULT_SETTINGS: OsmosisSettings = {
  isOn: true,
  level: 'beginner',
  density: 'normal',
  show: 'hanzi',
  isBandOn: true,
  card: 'word',
  lang: 'Mandarin',
}

export const EMPTY_PROGRESS: OsmosisProgress = {
  seen: {},
  known: {},
  saved: {},
  mastery: {},
  today: { date: '', count: 0 },
}

export function hashText(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995)
    b ^= b >>> 15
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

export function keyFor(text: string, s: OsmosisSettings): string {
  return hashText(`${s.lang}|${s.level}|${s.density}|${text}`)
}

export function scopeFor(key: string, index: number): string {
  return `tw-${key}-${index}`
}

export type LangInfo = { isMandarin: boolean; label: string; name: string }

export function langInfo(lang: string): LangInfo {
  const isMandarin = /mandarin|chinese|中文|普通话|^zh/i.test(lang.trim())
  return isMandarin
    ? { isMandarin, label: '中文', name: 'Mandarin Chinese' }
    : { isMandarin, label: lang.trim(), name: lang.trim() }
}

// ---------- block splitting ----------

export type Block = { start: number; end: number; isProse: boolean }
type Line = { start: number; end: number; text: string }

const FENCE = /^\s*(`{3,}|~{3,})/

function linesOf(text: string): Line[] {
  const out: Line[] = []
  let pos = 0
  for (const raw of text.split('\n')) {
    out.push({ start: pos, end: pos + raw.length, text: raw })
    pos += raw.length + 1
  }
  return out
}

function isProseLine(t: string): boolean {
  if (/^( {4,}|\t)/.test(t)) return false
  const s = t.trimStart()
  if (/^(#|>|\||<)/.test(s)) return false
  if (/^(-{3,}|={3,}|\*{3,}|_{3,})\s*$/.test(s)) return false
  if (/\|.*\|/.test(s)) return false
  return true
}

export function splitBlocks(text: string): Block[] {
  const lines = linesOf(text)
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.text.trim() === '') {
      i++
      continue
    }
    const fence = FENCE.exec(line.text)
    if (fence) {
      const mark = fence[1]!
      const close = new RegExp(`^\\s*${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`)
      let j = i + 1
      while (j < lines.length && !close.test(lines[j]!.text)) j++
      const last = Math.min(j, lines.length - 1)
      blocks.push({ start: line.start, end: lines[last]!.end, isProse: false })
      i = last + 1
      continue
    }
    let j = i
    while (j + 1 < lines.length && lines[j + 1]!.text.trim() !== '' && !FENCE.test(lines[j + 1]!.text)) j++
    const own = lines.slice(i, j + 1)
    blocks.push({ start: line.start, end: lines[j]!.end, isProse: own.every(l => isProseLine(l.text)) })
    i = j + 1
  }
  return blocks
}

// ---------- inline parsing ----------

export type PieceKind = 'text' | 'bold' | 'italic' | 'code' | 'link' | 'url'
export type Piece = { kind: PieceKind; text: string; start: number; end: number; href?: string }

const INLINE =
  /``([^\n]+?)``|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])|(https?:\/\/[^\s)<>\]]+)/g

export function parseInline(content: string, base: number): Piece[] {
  const out: Piece[] = []
  let last = 0
  INLINE.lastIndex = 0
  for (let m = INLINE.exec(content); m !== null; m = INLINE.exec(content)) {
    if (m.index > last) out.push({ kind: 'text', text: content.slice(last, m.index), start: base + last, end: base + m.index })
    const start = base + m.index
    const end = start + m[0].length
    if (m[1] !== undefined || m[2] !== undefined) out.push({ kind: 'code', text: (m[1] ?? m[2])!, start, end })
    else if (m[3] !== undefined) out.push({ kind: 'link', text: m[3], href: m[4]!, start, end })
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ kind: 'bold', text: (m[5] ?? m[6])!, start, end })
    else if (m[7] !== undefined || m[8] !== undefined) out.push({ kind: 'italic', text: (m[7] ?? m[8])!, start, end })
    else out.push({ kind: 'url', text: m[9]!, start, end })
    last = m.index + m[0].length
  }
  if (last < content.length) out.push({ kind: 'text', text: content.slice(last), start: base + last, end: base + content.length })
  return out
}

const MARKER = /^(\s*)([-*+]|\d{1,3}[.)])\s+/

export type ProseLine = { marker: string | null; indent: number; pieces: Piece[] }

export function proseLines(text: string, block: Block): ProseLine[] {
  const out: ProseLine[] = []
  for (const line of linesOf(text.slice(block.start, block.end))) {
    const abs = block.start + line.start
    const m = MARKER.exec(line.text)
    if (m) {
      const contentStart = m[0].length
      out.push({ marker: m[2]!, indent: m[1]!.length, pieces: parseInline(line.text.slice(contentStart), abs + contentStart) })
    } else {
      const lead = line.text.length - line.text.trimStart().length
      out.push({ marker: null, indent: 0, pieces: parseInline(line.text.slice(lead), abs + lead) })
    }
  }
  return out
}

export type Range = { start: number; end: number }

export function eligibleRanges(text: string): Range[] {
  const out: Range[] = []
  for (const block of splitBlocks(text)) {
    if (!block.isProse) continue
    for (const line of proseLines(text, block)) {
      for (const p of line.pieces) if (p.kind === 'text') out.push({ start: p.start, end: p.end })
    }
  }
  return out
}

// ---------- validating a model reply ----------

const WORD = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/
const LEAD_PUNCT = /^[("'“‘[]+/
const TRAIL_PUNCT = /[.,;:!?)"'”’\]]+$/
const CJK = /[㐀-鿿豈-﫿]/

function isPlainPhrase(en: string): boolean {
  if (en.length === 0 || en.length > 40) return false
  const words = en.split(' ')
  if (words.length > 4) return false
  return words.every(w => WORD.test(w) && !/[a-z][A-Z]/.test(w) && !/^[A-Z]{2,}$/.test(w))
}

function tokenAround(text: string, pos: number, range: Range): Range {
  let s = pos
  while (s > range.start && !/\s/.test(text[s - 1]!)) s--
  let e = pos
  while (e < range.end && !/\s/.test(text[e]!)) e++
  let token = text.slice(s, e)
  const lead = LEAD_PUNCT.exec(token)?.[0].length ?? 0
  token = token.slice(lead)
  const trail = TRAIL_PUNCT.exec(token)?.[0].length ?? 0
  return { start: s + lead, end: e - trail }
}

export function isSwappable(text: string, start: number, end: number, ranges: Range[]): boolean {
  const range = ranges.find(r => r.start <= start && end <= r.end)
  if (!range) return false
  if (!isPlainPhrase(text.slice(start, end))) return false
  const first = tokenAround(text, start, range)
  const last = tokenAround(text, end - 1, range)
  return first.start === start && last.end === end
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = []
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i)
  return out
}

export function locate(text: string, en: string, occurrence: number, ranges: Range[]): number | null {
  const raw = occurrences(text, en)
  const atRaw = raw[occurrence - 1]
  if (atRaw !== undefined && isSwappable(text, atRaw, atRaw + en.length, ranges)) return atRaw
  const whole = raw.filter(i => !/[A-Za-z0-9_]/.test(text[i - 1] ?? ' ') && !/[A-Za-z0-9_]/.test(text[i + en.length] ?? ' '))
  const atWhole = whole[occurrence - 1]
  if (atWhole !== undefined && isSwappable(text, atWhole, atWhole + en.length, ranges)) return atWhole
  return null
}

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export type ParseOptions = {
  isMandarin: boolean
  known: ReadonlySet<string>
  cap: number
}

export type ParseResult = { ok: true; words: OsmosisWord[] } | { ok: false; reason: string }

export function extractJson(reply: string): unknown {
  const cleaned = reply.replace(/```(?:json)?/gi, '')
  const a = cleaned.indexOf('[')
  const b = cleaned.lastIndexOf(']')
  if (a === -1 || b <= a) {
    const o = cleaned.indexOf('{')
    const p = cleaned.lastIndexOf('}')
    if (o === -1 || p <= o) return undefined
    try {
      const obj = JSON.parse(cleaned.slice(o, p + 1)) as { words?: unknown }
      return Array.isArray(obj.words) ? obj.words : undefined
    } catch {
      return undefined
    }
  }
  try {
    return JSON.parse(cleaned.slice(a, b + 1))
  } catch {
    return undefined
  }
}

export function parseReply(reply: string, text: string, opts: ParseOptions): ParseResult {
  const data = extractJson(reply)
  if (!Array.isArray(data)) return { ok: false, reason: 'not-json' }
  const ranges = eligibleRanges(text)
  const words: OsmosisWord[] = []
  const taken: Range[] = []
  const seenEn = new Set<string>()
  let knownUsed = 0
  for (const item of data) {
    if (words.length >= Math.min(opts.cap, MAX_SWAPS)) break
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const en = typeof o.en === 'string' ? o.en : ''
    const occurrence = Math.trunc(Number(o.occurrence ?? 1))
    const target = str(o.target ?? o.zh, 24)
    if (!en || !target || !Number.isFinite(occurrence) || occurrence < 1) continue
    if (opts.isMandarin ? !CJK.test(target) : target.toLowerCase() === en.toLowerCase()) continue
    if (seenEn.has(en.toLowerCase())) continue
    const isKnown = opts.known.has(target)
    if (isKnown && knownUsed >= 1) continue
    const start = locate(text, en, occurrence, ranges)
    if (start === null) continue
    const end = start + en.length
    if (taken.some(r => start < r.end && r.start < end)) continue
    const lvl = Number(o.level ?? o.hsk)
    words.push({
      en,
      occurrence,
      target,
      romanization: str(o.romanization ?? o.pinyin, 60),
      pos: str(o.pos, 30),
      gloss: str(o.gloss, 120),
      literal: str(o.literal, 160),
      exampleTarget: str(o.example_target ?? o.example_zh, 160),
      exampleRomanization: str(o.example_romanization ?? o.example_pinyin, 240),
      exampleEn: str(o.example_en, 200),
      level: Number.isInteger(lvl) && lvl >= 1 && lvl <= 6 ? lvl : null,
      start,
      end,
    })
    taken.push({ start, end })
    seenEn.add(en.toLowerCase())
    if (isKnown) knownUsed++
  }
  words.sort((x, y) => x.start - y.start)
  return { ok: true, words }
}

// ---------- the prompt ----------

export const RULES = `You pick words for Osmosis, a language-learning layer. You read one block of an AI assistant's reply (markdown) and choose English words or short phrases to show in a target language, so a learner picks up vocabulary while reading.

Rules:
1. Pick ONLY from plain prose sentences. Never pick text inside inline code (\`like this\`), code fences, URLs, file paths, command names, identifiers (camelCase, snake_case, names with dots, slashes or digits), numbers, version strings, table rows, headings, block quotes, link text, or bold text.
2. "en" is copied exactly, character for character and with the same case, from the block. It is a whole word or a whole phrase, never part of a word, with no punctuation around it.
3. "occurrence" says which appearance of that exact "en" string you mean, counting from 1 at the start of the block.
4. The translation must fit the meaning in this sentence. Prefer common, useful vocabulary. Never pick the same English word twice.
5. Follow the level and the density given, and never go over the item limit.
6. Avoid the learner's known words unless nothing else fits; use at most one known word.
7. Gently prefer words from the "seen often, not saved" list when they occur naturally, so the learner reviews them.
8. Reply with strict JSON only: one array, no prose, no code fence. If nothing fits, reply [].

Each item has exactly these fields:
{"en": "computer", "occurrence": 1, "target": "电脑", "romanization": "diànnǎo", "pos": "noun", "gloss": "computer", "literal": "电 electric + 脑 brain", "example_target": "我的电脑很快。", "example_romanization": "Wǒ de diànnǎo hěn kuài.", "example_en": "My computer is fast.", "level": 1}

- target: the word in the target language (for Mandarin: simplified hanzi).
- romanization: for Mandarin, pinyin with tone marks; for a language in Latin script, "".
- pos: noun, verb, adjective, adverb, phrase or idiom.
- gloss: a short English meaning in this context.
- literal: a part-by-part breakdown (for Mandarin, character by character).
- example_*: one short, simple example sentence that uses the word, its romanization and its English.
- level: HSK level 1-6 for Mandarin; for other languages the CEFR step as 1-6 (A1=1 ... C2=6); null if unsure.`

const LEVEL_RULES: Record<OsmosisLevel, { zh: string; other: string }> = {
  beginner: {
    zh: 'beginner: HSK 1-2 words only; nouns and verbs; single words, no phrases.',
    other: 'beginner: A1-A2 words only; nouns and verbs; single words, no phrases.',
  },
  intermediate: {
    zh: 'intermediate: HSK 3-4 words; also adjectives and adverbs; two-word phrases are fine.',
    other: 'intermediate: B1-B2 words; also adjectives and adverbs; two-word phrases are fine.',
  },
  advanced: {
    zh: 'advanced: HSK 5-6 words; idioms (成语) where they fit naturally; short phrases are fine.',
    other: 'advanced: C1-C2 words; idioms where they fit naturally; short phrases are fine.',
  },
}

const DENSITY_RULES: Record<OsmosisDensity, { text: string; perSentence: number }> = {
  low: { text: 'low: about 1 item per 3 sentences.', perSentence: 1 / 3 },
  normal: { text: 'normal: about 1 item per sentence.', perSentence: 1 },
  high: { text: 'high: about 2 items per sentence.', perSentence: 2 },
}

export function countSentences(text: string): number {
  let n = 0
  for (const block of splitBlocks(text)) {
    if (!block.isProse) continue
    const body = text.slice(block.start, block.end)
    const ends = body.match(/[.!?](\s|$)/g)?.length ?? 0
    const lines = body.split('\n').filter(l => l.trim() !== '').length
    n += Math.max(ends, lines)
  }
  return n
}

export function swapCap(text: string, density: OsmosisDensity): number {
  const n = countSentences(text)
  if (n === 0) return 0
  return Math.max(1, Math.min(MAX_SWAPS, Math.ceil(n * DENSITY_RULES[density].perSentence)))
}

export type PromptLists = { known: string[]; review: string[]; saved: string[] }

export function reviewLists(progress: OsmosisProgress): PromptLists {
  const known = Object.keys(progress.known).slice(-80)
  const saved = Object.keys(progress.saved).slice(-60)
  const review = Object.entries(progress.seen)
    .filter(([t, s]) => s.n >= 3 && !progress.known[t] && !progress.saved[t])
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 40)
    .map(([t, s]) => `${t} (${s.en})`)
  return { known, review, saved }
}

export function buildPrompt(text: string, s: OsmosisSettings, lists: PromptLists, cap: number): string {
  const info = langInfo(s.lang)
  const level = info.isMandarin ? LEVEL_RULES[s.level].zh : LEVEL_RULES[s.level].other
  const target = info.isMandarin
    ? 'Mandarin Chinese (simplified characters; pinyin with tone marks)'
    : info.name
  return [
    `Target language: ${target}`,
    `Level: ${level}`,
    `Density: ${DENSITY_RULES[s.density].text}`,
    `Item limit for this block: ${cap}`,
    `Known words (avoid): ${lists.known.join(', ') || 'none'}`,
    `Seen often, not saved (review gently): ${lists.review.join(', ') || 'none'}`,
    `Saved words (fine to reuse when natural): ${lists.saved.join(', ') || 'none'}`,
    '',
    'Block:',
    '<<<',
    text,
    '>>>',
  ].join('\n')
}

// ---------- speech ----------

export function pickVoice(listing: string): string | undefined {
  const lines = listing.split('\n')
  if (lines.some(l => /^Ting-?Ting\b/i.test(l))) return 'Tingting'
  const zh = lines.find(l => /\szh_CN\s/.test(l))
  return zh ? /^(.+?)\s+[a-z]{2,3}_[A-Z]{2,}\s/.exec(zh)?.[1]?.trim() : undefined
}

// ---------- drawing helpers ----------

export function shownText(w: OsmosisWord, show: OsmosisSettings['show']): string {
  if (show === 'pinyin' && w.romanization) return w.romanization
  return w.target
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return n
}

// ---------- planning a translated message ----------

export type Part = { text: string; kind: PieceKind; href?: string }
export type Token = { kind: 'parts'; parts: Part[] } | { kind: 'swap'; index: number; trailing: string }
export type DrawLine = { marker: string | null; indent: number; tokens: Token[] }
export type Segment = { kind: 'md'; text: string } | { kind: 'prose'; lines: DrawLine[] }

function tokenizeLine(text: string, line: ProseLine, words: readonly OsmosisWord[]): DrawLine {
  const tokens: Token[] = []
  let cur: Part[] | null = null
  const flush = () => {
    if (cur && cur.length) tokens.push({ kind: 'parts', parts: cur })
    cur = null
  }
  const pushText = (s: string, kind: PieceKind, href?: string) => {
    for (const chunk of s.match(/\S+\s*|\s+/g) ?? []) {
      const part: Part = href === undefined ? { text: chunk, kind } : { text: chunk, kind, href }
      if (/^\s+$/.test(chunk)) {
        if (cur) {
          cur.push(part)
          flush()
        } else {
          const last = tokens[tokens.length - 1]
          if (last?.kind === 'swap') last.trailing += chunk
        }
        continue
      }
      if (!cur) cur = []
      cur.push(part)
      if (/\s$/.test(chunk)) flush()
    }
  }
  for (const piece of line.pieces) {
    if (piece.kind !== 'text') {
      pushText(piece.text, piece.kind, piece.href)
      continue
    }
    let cursor = piece.start
    words.forEach((w, index) => {
      if (w.start < piece.start || w.end > piece.end) return
      pushText(text.slice(cursor, w.start), 'text')
      flush()
      tokens.push({ kind: 'swap', index, trailing: '' })
      cursor = w.end
    })
    pushText(text.slice(cursor, piece.end), 'text')
  }
  flush()
  return { marker: line.marker, indent: line.indent, tokens }
}

export function planMessage(text: string, words: readonly OsmosisWord[]): Segment[] {
  const segs: Segment[] = []
  let mdStart: number | null = null
  let mdEnd = 0
  const flushMd = () => {
    if (mdStart === null) return
    const body = text.slice(mdStart, mdEnd).replace(/\s+$/, '')
    if (body) segs.push({ kind: 'md', text: body })
    mdStart = null
  }
  for (const block of splitBlocks(text)) {
    const hasSwap = words.some(w => w.start >= block.start && w.end <= block.end)
    if (block.isProse && hasSwap) {
      flushMd()
      segs.push({ kind: 'prose', lines: proseLines(text, block).map(l => tokenizeLine(text, l, words)) })
    } else {
      if (mdStart === null) mdStart = block.start
      mdEnd = block.end
    }
  }
  flushMd()
  return segs
}

// ---------- floating card placement ----------

export type SwapSpot = { row: number; x: number; avail: number }

function tokenWidth(t: Token, words: readonly OsmosisWord[], show: OsmosisSettings['show']): number {
  if (t.kind === 'parts') return cellWidth(t.parts.map(p => p.text).join(''))
  const w = words[t.index]!
  const extra = show === 'both' && w.romanization ? 1 + cellWidth(w.romanization) : 0
  return cellWidth(shownText(w, show)) + extra + cellWidth(t.trailing)
}

export function placeSwaps(
  segs: readonly Segment[],
  words: readonly OsmosisWord[],
  show: OsmosisSettings['show'],
  columns: number,
): Map<number, SwapSpot> {
  const spots = new Map<number, SwapSpot>()
  const body = Math.max(10, columns - 2)
  let row = 0
  segs.forEach((seg, si) => {
    if (si > 0) row += 1
    if (seg.kind === 'md') {
      for (const line of seg.text.split('\n')) row += Math.max(1, Math.ceil(cellWidth(line) / body))
      return
    }
    for (const line of seg.lines) {
      const avail = Math.max(8, body - line.indent - (line.marker === null ? 0 : line.marker.length + 1))
      let x = 0
      for (const t of line.tokens) {
        const w = tokenWidth(t, words, show)
        if (x > 0 && x + w > avail) {
          row++
          x = 0
        }
        if (t.kind === 'swap') spots.set(t.index, { row, x, avail })
        x += w
      }
      row++
    }
  })
  return spots
}

export const CARD_MAX = 40

export function cardLines(w: OsmosisWord): string[] {
  return [
    `${w.target}  ${w.romanization}`.trim(),
    [w.pos, w.gloss].filter(Boolean).join(' \u00b7 '),
    w.literal,
    [w.level ? `HSK ${w.level}` : '', 'click for more'].filter(Boolean).join(' \u00b7 '),
  ].filter(Boolean)
}

export type CardPlace = { top: number; side: 'left' | 'right'; inner: number; height: number }

export type OnScreenRows = { first: number; last: number } | null | undefined

export function placeCard(spot: SwapSpot, lines: readonly string[], onScreen: OnScreenRows): CardPlace {
  const widest = Math.max(...lines.map(cellWidth))
  const inner = Math.max(4, Math.min(widest, CARD_MAX - 4, spot.avail - 4))
  const width = inner + 4
  const height = lines.length + 2
  const siteRow = spot.row + 1
  const fitsInMessage = spot.row >= height
  const fitsOnScreen = !onScreen || siteRow - height >= onScreen.first
  const top = fitsInMessage && fitsOnScreen ? -height : 1
  const side = spot.x + width > spot.avail && spot.x > 0 ? 'right' : 'left'
  return { top, side, inner, height }
}

export function padCells(s: string, cells: number): string {
  let out = ''
  for (const ch of s) {
    if (cellWidth(out + ch) > cells) break
    out += ch
  }
  return out + ' '.repeat(Math.max(0, cells - cellWidth(out)))
}
