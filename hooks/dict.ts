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

export function verifyWord(w: OsmosisWord, dict: Dict): OsmosisWord {
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
