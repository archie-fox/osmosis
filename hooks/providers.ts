import type { OsmosisCap, OsmosisProvider, OsmosisSettings, OsmosisTally, OsmosisUsage } from '../types'
import { langInfo } from './core'

// ---------- usage and the daily cap ----------

export type CallUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export const EMPTY_TALLY: OsmosisTally = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const EMPTY_USAGE: OsmosisUsage = { days: {} }
const KEEP_DAYS = 31

export function addUsage(usage: OsmosisUsage, day: string, provider: OsmosisProvider, u: CallUsage): OsmosisUsage {
  const was = usage.days[day]?.[provider] ?? EMPTY_TALLY
  const tally: OsmosisTally = {
    calls: was.calls + 1,
    input: was.input + u.input,
    output: was.output + u.output,
    cacheRead: was.cacheRead + u.cacheRead,
    cacheWrite: was.cacheWrite + u.cacheWrite,
  }
  const days = { ...usage.days, [day]: { ...usage.days[day], [provider]: tally } }
  const keys = Object.keys(days).sort()
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k]
  return { days }
}

export function totalTokens(t: OsmosisTally | undefined): number {
  return t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0
}

export function inTokens(t: OsmosisTally | undefined): number {
  return t ? t.input + t.cacheRead + t.cacheWrite : 0
}

export function capTokens(cap: OsmosisCap): number | null {
  return cap === 'off' ? null : cap === '100k' ? 100_000 : cap === '300k' ? 300_000 : 1_000_000
}

export function isCapReached(usage: OsmosisUsage, day: string, s: OsmosisSettings): boolean {
  const limit = capTokens(s.cap)
  return s.model === 'haiku' && limit !== null && totalTokens(usage.days[day]?.haiku) >= limit
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

export function lastDays(today: string, n: number): string[] {
  const t = Date.parse(`${today}T00:00:00Z`)
  return Array.from({ length: n }, (_, i) => new Date(t - i * 86_400_000).toISOString().slice(0, 10))
}

export function usageLines(usage: OsmosisUsage, today: string): string[] {
  const lines: string[] = []
  for (const provider of ['haiku', 'local'] as const) {
    const t = usage.days[today]?.[provider]
    const week = lastDays(today, 7).reduce((sum, d) => sum + totalTokens(usage.days[d]?.[provider]), 0)
    if (provider === 'local' && !t && week === 0) continue
    const name = provider === 'haiku' ? 'Today' : 'Local model today'
    lines.push(
      `${name}: ${t?.calls ?? 0} calls · ${fmtTokens(totalTokens(t))} tokens (${fmtTokens(inTokens(t))} in / ${fmtTokens(t?.output ?? 0)} out) · 7 days: ${fmtTokens(week)}`,
    )
  }
  return lines
}

// ---------- the example sentence ----------

export const EXAMPLE_MARK = 'EXAMPLE REQUEST'

export function examplePrompt(target: string, romanization: string, gloss: string, s: OsmosisSettings): string {
  const info = langInfo(s.lang)
  return [
    EXAMPLE_MARK,
    `Write one short, simple example sentence in ${info.name} that uses the word ${target}${romanization ? ` (${romanization})` : ''}, meaning "${gloss}".`,
    `Learner level: ${s.level}. Keep it under 12 words.`,
    'Reply with strict JSON only, one object, no code fence:',
    `{"example_target": "<the sentence>", "example_romanization": "<${info.isMandarin ? 'pinyin with tone marks' : 'romanization, or empty'}>", "example_en": "<English translation>"}`,
  ].join('\n')
}

export type ExampleReply = { target: string; romanization: string; en: string }

export function parseExample(reply: string): ExampleReply | null {
  const cleaned = reply.replace(/```(?:json)?/gi, '')
  const a = cleaned.indexOf('{')
  const b = cleaned.lastIndexOf('}')
  if (a === -1 || b <= a) return null
  try {
    const o = JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>
    const target = typeof o.example_target === 'string' ? o.example_target.trim().slice(0, 160) : ''
    if (!target) return null
    const romanization = typeof o.example_romanization === 'string' ? o.example_romanization.trim().slice(0, 240) : ''
    const en = typeof o.example_en === 'string' ? o.example_en.trim().slice(0, 200) : ''
    return { target, romanization, en }
  } catch {
    return null
  }
}

// ---------- a local OpenAI-compatible server ----------

const WORD_ITEM = {
  type: 'object',
  properties: {
    en: { type: 'string' },
    occurrence: { type: 'integer', minimum: 1 },
    target: { type: 'string' },
    romanization: { type: 'string' },
    pos: { type: 'string' },
    gloss: { type: 'string' },
    level: { type: ['integer', 'null'], minimum: 1, maximum: 6 },
  },
  required: ['en', 'occurrence', 'target', 'romanization', 'pos', 'gloss', 'level'],
  additionalProperties: false,
}

export function wordsSchema(cap: number) {
  return { type: 'array', items: WORD_ITEM, minItems: 0, maxItems: Math.max(1, cap) }
}

export const EXAMPLE_SCHEMA = {
  type: 'object',
  properties: {
    example_target: { type: 'string' },
    example_romanization: { type: 'string' },
    example_en: { type: 'string' },
  },
  required: ['example_target', 'example_romanization', 'example_en'],
  additionalProperties: false,
}

export type LocalRequest = { url: string; body: string }

export function localRequest(
  s: Pick<OsmosisSettings, 'endpoint' | 'localModel'>,
  system: string,
  prompt: string,
  schema: object | null,
  maxTokens: number,
): LocalRequest {
  const base = s.endpoint.trim().replace(/\/+$/, '')
  const body: Record<string, unknown> = {
    model: s.localModel || 'local',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: false,
  }
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'osmosis', strict: true, schema } }
  return { url: `${base}/chat/completions`, body: JSON.stringify(body) }
}

export type LocalReply = { text: string; usage: CallUsage }

export function parseLocalReply(raw: string): LocalReply | null {
  try {
    const o = JSON.parse(raw) as {
      choices?: { message?: { content?: unknown } }[]
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
    }
    const text = o.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) return null
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      text,
      usage: { input: num(o.usage?.prompt_tokens), output: num(o.usage?.completion_tokens), cacheRead: 0, cacheWrite: 0 },
    }
  } catch {
    return null
  }
}

export function isLocalUrl(endpoint: string): boolean {
  return /^https?:\/\//i.test(endpoint.trim())
}
