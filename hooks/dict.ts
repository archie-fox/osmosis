import type { OsmosisWord } from '../types'

export type Reading = { reading: string; gloss: string }
export type Dict = { rows: Map<string, string>; hsk: Map<string, number> }

export const EMPTY_DICT: Dict = { rows: new Map(), hsk: new Map() }

// Keeps each row raw ("reading\tgloss\t..."); readings decode on first use.
export function parseCedict(text: string, into: Map<string, string> = new Map()): Map<string, string> {
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    const tab = text.indexOf('\t', start)
    if (tab > start && tab < end) into.set(text.slice(start, tab), text.slice(tab + 1, end))
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

const decoded = new Map<string, Reading[]>()

export function readings(dict: Dict, word: string): Reading[] | undefined {
  const row = dict.rows.get(word)
  if (row === undefined) return undefined
  const hit = decoded.get(row)
  if (hit) return hit
  const cells = row.split('\t')
  const list: Reading[] = []
  for (let i = 0; i + 1 < cells.length; i += 2) list.push({ reading: cells[i]!, gloss: cells[i + 1]! })
  decoded.set(row, list)
  if (decoded.size > 2000) decoded.delete(decoded.keys().next().value as string)
  return list
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]+/g) ?? [])

export function bestReading(list: readonly Reading[], gloss: string): Reading {
  const want = words(gloss)
  const scored = list.map(r => [...words(r.gloss)].filter(w => w.length > 2 && want.has(w)).length)
  const top = Math.max(...scored)
  if (top > 0) return list[scored.indexOf(top)]!
  return list.find(r => r.reading === r.reading.toLowerCase() && !JUNK.test(r.gloss)) ?? list[0]!
}

const JUNK = /^(used in|see |variant of|old variant|surname |abbr\.|CL:)/
const short = (g: string) => g.replace(/^to /, '').replace(/\s*\(.*?\)\s*/g, ' ').trim()

export function charGloss(list: readonly Reading[] | undefined): string | undefined {
  const good = list?.find(r => r.gloss && !JUNK.test(r.gloss))
  return good ? short(good.gloss) || undefined : undefined
}

const HAN = /[㐀-鿿豈-﫿]/

export function literalFor(target: string, dict: Dict, fallback: string): string {
  const chars = [...target].filter(ch => HAN.test(ch))
  const parts = chars.map(ch => [ch, charGloss(readings(dict, ch))] as const)
  return chars.length && parts.every(([, g]) => g) ? parts.map(([ch, g]) => `${ch} ${g}`).join(' + ') : fallback
}

export function segment(target: string, dict: Dict, maxLen = 8): string[] {
  const chars = [...target].filter(ch => HAN.test(ch))
  const out: string[] = []
  for (let i = 0; i < chars.length; ) {
    let len = Math.min(maxLen, chars.length - i)
    while (len > 1 && !dict.rows.has(chars.slice(i, i + len).join(''))) len--
    out.push(chars.slice(i, i + len).join(''))
    i += len
  }
  return out
}

// Sets pinyin, HSK and the breakdown from CC-CEDICT; verified only when every word is found.
export function verifyWord(w: OsmosisWord, dict: Dict): OsmosisWord {
  if (w.kind !== 'phrase') {
    const list = readings(dict, w.target)
    const literal = literalFor(w.target, dict, w.literal)
    if (!list?.length) return { ...w, literal, verified: false }
    const pick = bestReading(list, w.gloss)
    return { ...w, romanization: pick.reading, level: dict.hsk.get(w.target) ?? null, literal, dictGloss: pick.gloss, verified: true }
  }
  const pieces = segment(w.target, dict)
  const found = pieces.map(p => readings(dict, p))
  if (pieces.length === 0 || found.some(f => !f?.length)) return { ...w, verified: false }
  const picks = found.map(list => bestReading(list!, w.gloss))
  const levels = pieces.map(p => dict.hsk.get(p))
  return {
    ...w,
    romanization: picks.map(r => r.reading).join(' '),
    literal: pieces.map((p, i) => `${p} ${short(picks[i]!.gloss) || '?'}`).join(' + '),
    level: levels.every(l => l !== undefined) ? Math.max(...(levels as number[])) : null,
    verified: true,
  }
}
