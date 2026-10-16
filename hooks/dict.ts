import type { OsmosisWord } from '../types'

export type Reading = { reading: string; gloss: string }
export type Dict = { words: Map<string, Reading[]>; hsk: Map<string, number> }

export const EMPTY_DICT: Dict = { words: new Map(), hsk: new Map() }

export function parseCedict(text: string, into: Map<string, Reading[]> = new Map()): Map<string, Reading[]> {
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    if (end > start) {
      const cells = text.slice(start, end).split('\t')
      const list: Reading[] = []
      for (let i = 1; i + 1 < cells.length; i += 2) list.push({ reading: cells[i]!, gloss: cells[i + 1]! })
      if (cells[0] && list.length) into.set(cells[0], list)
    }
    start = end + 1
  }
  return into
}

export function parseHsk(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of text.split('\n')) {
    const [w, n] = line.split('\t')
    const level = Number(n)
    if (w && level >= 1 && level <= 6) out.set(w, level)
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[\s'’·,-]/g, '')
const toneless = (s: string) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ü/g, 'v')

export function bestReading(list: readonly Reading[], modelPinyin: string): Reading {
  const m = norm(modelPinyin)
  const exact = list.find(r => norm(r.reading) === m)
  if (exact) return exact
  const bare = toneless(modelPinyin)
  const loose = list.find(r => toneless(r.reading) === bare)
  if (loose) return loose
  const common = list.find(r => r.reading === r.reading.toLowerCase())
  return common ?? list[0]!
}

const JUNK = /^(used in|see |variant of|old variant|surname |abbr\.|CL:)/

export function charGloss(list: readonly Reading[] | undefined): string | undefined {
  if (!list) return undefined
  const good = list.find(r => r.gloss && !JUNK.test(r.gloss))
  return good?.gloss.replace(/^to /, '').replace(/\s*\(.*?\)\s*/g, ' ').trim() || undefined
}

export function literalFor(target: string, dict: Dict, fallback: string): string {
  const chars = [...target].filter(ch => /[㐀-鿿豈-﫿]/.test(ch))
  if (chars.length === 0) return fallback
  const parts: string[] = []
  for (const ch of chars) {
    const g = charGloss(dict.words.get(ch))
    if (!g) return fallback
    parts.push(`${ch} ${g}`)
  }
  return parts.join(' + ')
}

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/

export function segment(target: string, dict: Dict, maxLen = 8): string[] {
  const chars = [...target].filter(ch => HAN.test(ch))
  const out: string[] = []
  let i = 0
  while (i < chars.length) {
    let len = Math.min(maxLen, chars.length - i)
    while (len > 1 && !dict.words.has(chars.slice(i, i + len).join(''))) len--
    out.push(chars.slice(i, i + len).join(''))
    i += len
  }
  return out
}

function pieceReading(list: readonly Reading[], hint: string): Reading {
  const h = toneless(hint)
  const inHint = list.filter(r => h.includes(toneless(r.reading)))
  if (inHint.length) {
    const exact = inHint.find(r => norm(hint).includes(norm(r.reading)))
    return exact ?? inHint[0]!
  }
  return list.find(r => r.reading === r.reading.toLowerCase()) ?? list[0]!
}

const shortWord = (g: string) => g.replace(/^to /, '').replace(/\s*\(.*?\)\s*/g, ' ').trim()

export function verifyPhrase(w: OsmosisWord, dict: Dict): OsmosisWord {
  const pieces = segment(w.target, dict)
  if (pieces.length === 0) return { ...w, verified: false }
  const found = pieces.map(p => dict.words.get(p))
  if (found.some(f => !f || f.length === 0)) return { ...w, verified: false }
  const readings = found.map(list => pieceReading(list!, w.romanization))
  const levels = pieces.map(p => dict.hsk.get(p))
  return {
    ...w,
    romanization: readings.map(r => r.reading).join(' '),
    literal: pieces.map((p, i) => `${p} ${shortWord(readings[i]!.gloss) || '?'}`).join(' + '),
    level: levels.every(l => l !== undefined) ? Math.max(...(levels as number[])) : null,
    verified: true,
  }
}

export function verifyWord(w: OsmosisWord, dict: Dict): OsmosisWord {
  if (w.kind === 'phrase') return verifyPhrase(w, dict)
  const list = dict.words.get(w.target)
  const literal = literalFor(w.target, dict, w.literal)
  if (!list || list.length === 0) return { ...w, literal, verified: false }
  const pick = bestReading(list, w.romanization)
  return {
    ...w,
    romanization: pick.reading,
    level: dict.hsk.get(w.target) ?? null,
    literal,
    dictGloss: pick.gloss,
    verified: true,
  }
}
