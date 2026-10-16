import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type {

  OsmosisProgress,
  OsmosisProvider,
  OsmosisQuestion,
  OsmosisSettings,
  OsmosisUsage,
  OsmosisWord,
} from '../types'
import {
  DEFAULT_SETTINGS,
  EMPTY_PROGRESS,
  MIN_CHARS,
  RULES,
  buildPrompt,
  dayOf,
  rawFinalsFromHistory,
  hashText,
  isFinalBlock,
  keyFor,
  langInfo,
  normText,
  parseReply,
  pickVoice,
  planCards,
  planMessage,
  reviewLists,
  scopeFor,
  swapCap,
} from './core'
import type { HistoryRow } from './core'
import { revertCopy } from './copyback'
import type { ShownBlock } from './copyback'
import { EMPTY_DICT, parseCedict, parseHsk, verifyWord } from './dict'
import type { Dict } from './dict'
import { drawBand, drawBank, drawHome, drawMessage, drawQuiz } from './draw'
import type { ExampleView, PaneActions } from './draw'
import {
  EMPTY_USAGE,
  EXAMPLE_SCHEMA,
  addUsage,
  examplePrompt,
  isCapReached,
  isLocalUrl,
  localRequest,
  parseExample,
  parseLocalReply,
  wordsSchema,
} from './providers'
import type { CallUsage, ExampleReply } from './providers'

const PANE = 'osmosis'
const SETTLE_MS = 1200
const TICK_MS = 400
const MAX_INFLIGHT = 2
const MAX_JOBS = 40
const CACHE_ITEMS = 500
const CACHE_CHARS = 2_500_000
const MAX_SEEN = 3000
const MAX_FINALS = 200
const EXAMPLE_ITEMS = 500
const LOCAL_TIMEOUT_MS = 90_000
const EXAMPLE_SYSTEM = 'You write short example sentences for a language learner. Reply with strict JSON only.'

const settingsAtom = atom({ plugin: 'osmosis', key: 'settings' } as const, DEFAULT_SETTINGS)
const recentAtom = atom({ plugin: 'osmosis', key: 'recent' } as const, [])
const latestAtom = atom({ plugin: 'osmosis', key: 'latest' } as const, null)
const selectedAtom = atom({ plugin: 'osmosis', key: 'selected' } as const, null)
const viewAtom = atom({ plugin: 'osmosis', key: 'view' } as const, 'home')
const quizAtom = atom({ plugin: 'osmosis', key: 'quiz' } as const, null)
const progressAtom = atom({ plugin: 'osmosis', key: 'progress' } as const, EMPTY_PROGRESS)
const finalsAtom = atom({ plugin: 'osmosis', key: 'finals' } as const, [])
const usageAtom = atom({ plugin: 'osmosis', key: 'usage' } as const, EMPTY_USAGE)
const fallbacksAtom = atom({ plugin: 'osmosis', key: 'fallbacks' } as const, [])
const healthAtom = atom({ plugin: 'osmosis', key: 'health' } as const, { local: 'unknown' as const })
const TX = { plugin: 'osmosis', key: 'tx' } as const
const EX = { plugin: 'osmosis', key: 'ex' } as const

type Job = { requestId: string; key: string; text: string; settings: OsmosisSettings; updatedAt: number }
type ExJob = { id: string; target: string; romanization: string; gloss: string }

type $T = EngineInterface

const jobs = new Map<string, Job>()
const inflightKeys = new Set<string>()
const attempts = new Map<string, number>()
const cache = new Map<string, OsmosisWord[]>()
const exJobs = new Map<string, ExJob>()
const exInflight = new Set<string>()
const exCache = new Map<string, ExampleReply>()
let inflight = 0
let ticks = 0
let isCacheDirty = false
let isProgressDirty = false
let isUsageDirty = false
let isExampleDirty = false
let voice: string | undefined
let isTicking = false
let dict: Dict | null = null
let dictLoading: Promise<Dict> | null = null
const fallbackByMsg = new Map<string, string[]>()
const keyText = new Map<string, string>()
type ClipTool = { read: string[]; write: string[]; name: string }
const CLIP_TOOLS: ClipTool[] = [
  { name: 'pbpaste', read: ['pbpaste'], write: ['pbcopy'] },
  { name: 'wl-paste', read: ['wl-paste', '--no-newline'], write: ['wl-copy'] },
  { name: 'xclip', read: ['xclip', '-selection', 'clipboard', '-o'], write: ['xclip', '-selection', 'clipboard'] },
]
let clipTool: ClipTool | null | undefined
let lastClipHash: string | null = null
let isClipBusy = false
const CLIP_MS = 400
const CLIP_BLOCKS = 30
let isFallbackDirty = false

// ---------- persistence ----------

async function loadAll($: $T) {
  const stored = (await $.store.get('settings')) as Partial<OsmosisSettings> | undefined
  await update($, settingsAtom, () => ({ ...DEFAULT_SETTINGS, ...(stored ?? {}) }))
  const progress = (await $.store.get('progress')) as Partial<OsmosisProgress> | undefined
  if (progress) await update($, progressAtom, () => ({ ...EMPTY_PROGRESS, ...progress }))
  const usage = (await $.store.get('usage')) as OsmosisUsage | undefined
  if (usage && typeof usage.days === 'object') await update($, usageAtom, () => usage)
  const pairs = (await $.store.get('cache')) as [string, OsmosisWord[]][] | undefined
  if (Array.isArray(pairs)) for (const [k, words] of pairs) if (typeof k === 'string' && Array.isArray(words)) cache.set(k, words)
  const examples = (await $.store.get('examples')) as [string, ExampleReply][] | undefined
  if (Array.isArray(examples)) for (const [k, ex] of examples) if (typeof k === 'string' && ex?.target) exCache.set(k, ex)
  const v = await $.store.get('voice')
  if (typeof v === 'string') voice = v
}

async function loadFinals($: $T) {
  const rows = (await $.session.messages()) as unknown
  if (!Array.isArray(rows)) return
  const found = rawFinalsFromHistory(rows as HistoryRow[]).map(normText)
  if (found.length) await update($, finalsAtom, list => [...new Set([...found, ...list])].slice(-MAX_FINALS))
}

function rememberText(key: string, text: string) {
  if (keyText.get(key) === text) return
  keyText.delete(key)
  keyText.set(key, text)
  while (keyText.size > CACHE_ITEMS) keyText.delete(keyText.keys().next().value as string)
}

function shownBlocks(): ShownBlock[] {
  const out: ShownBlock[] = []
  for (const [key, text] of [...keyText.entries()].reverse()) {
    const words = cache.get(key)
    if (words && words.length) out.push({ text, words })
    if (out.length >= CLIP_BLOCKS) break
  }
  return out
}

async function findClipTool($: $T): Promise<ClipTool | null> {
  for (const tool of CLIP_TOOLS) {
    try {
      const r = await $.process.run(tool.read, { timeoutMs: 3000 })
      if (r.exitCode === 0) return tool
    } catch {
      // not installed here
    }
  }
  return null
}

async function watchClipboard($: $T) {
  if (isClipBusy) return
  isClipBusy = true
  try {
    const s = await read($, settingsAtom)
    if (!s.isOn || s.copy !== 'english' || keyText.size === 0) return
    if (clipTool === undefined) clipTool = await findClipTool($)
    if (!clipTool) return
    const r = await $.process.run(clipTool.read, { timeoutMs: 3000 })
    if (r.exitCode !== 0 || r.isStdoutTruncated) return
    const hash = hashText(r.stdout)
    if (hash === lastClipHash) return
    const isFirst = lastClipHash === null
    lastClipHash = hash
    if (isFirst) return
    const english = revertCopy(r.stdout, shownBlocks(), s.show)
    if (english === null || english === r.stdout) return
    const w = await $.process.run(clipTool.write, { stdin: english, timeoutMs: 3000 })
    if (w.exitCode === 0) lastClipHash = hashText(english)
  } catch {
    // the clipboard stays as it was
  } finally {
    isClipBusy = false
  }
}

async function flush($: $T) {
  if (isCacheDirty) {
    isCacheDirty = false
    let pairs = [...cache.entries()].slice(-CACHE_ITEMS)
    while (pairs.length > 1 && JSON.stringify(pairs).length > CACHE_CHARS) pairs = pairs.slice(Math.ceil(pairs.length / 10))
    await $.store.set('cache', pairs)
  }
  if (isProgressDirty) {
    isProgressDirty = false
    await $.store.set('progress', await read($, progressAtom))
  }
  if (isUsageDirty) {
    isUsageDirty = false
    await $.store.set('usage', await read($, usageAtom))
  }
  if (isExampleDirty) {
    isExampleDirty = false
    await $.store.set('examples', [...exCache.entries()].slice(-EXAMPLE_ITEMS))
  }
}

async function detectVoice($: $T) {
  try {
    const { exitCode, stdout } = await $.process.run(['say', '-v', '?'], { timeoutMs: 10000 })
    if (exitCode !== 0) return
    const name = pickVoice(stdout)
    if (name) {
      voice = name
      await $.store.set('voice', name)
    }
  } catch {
    // no say on this machine: speak with the default voice
  }
}

function applyStatus($: $T, s: OsmosisSettings) {
  try {
    $.ui.status(s.isOn && s.isStatusOn ? `\u{1F331} ${langInfo(s.lang).label} · ${s.level}${s.model === 'local' ? ' · local' : ''}` : undefined)
  } catch {
    // status is cosmetic
  }
}

async function changeSettings($: $T, patch: Partial<OsmosisSettings>): Promise<OsmosisSettings> {
  const next = await update($, settingsAtom, s => ({ ...s, ...patch }))
  await $.store.set('settings', next)
  applyStatus($, next)
  return next
}

async function changeProgress($: $T, fn: (p: OsmosisProgress) => OsmosisProgress) {
  await update($, progressAtom, fn)
  isProgressDirty = true
}

// ---------- the dictionary ----------

async function readText($: $T, path: string): Promise<string> {
  const got = await $.fs.read(path)
  return typeof got === 'string' ? got : ''
}

async function loadDict($: $T): Promise<Dict> {
  const started = await $.clock.now()
  const root = `${$.plugin.root}/data`
  const sources = JSON.parse(await readText($, `${root}/sources.json`)) as { files: string[]; hsk: string }
  const words = new Map()
  for (const f of sources.files) parseCedict(await readText($, `${root}/${f}`), words)
  const hsk = parseHsk(await readText($, `${root}/${sources.hsk}`))
  const ms = (await $.clock.now()) - started
  try {
    $.ui.log(`osmosis: CC-CEDICT loaded in ${ms} ms (${words.size} words, ${hsk.size} HSK)`, { to: 'debug' })
  } catch {
    // logging is optional
  }
  return { words, hsk }
}

async function ensureDict($: $T): Promise<Dict> {
  if (dict) return dict
  if (!dictLoading) {
    dictLoading = loadDict($)
      .catch(() => EMPTY_DICT)
      .then(d => {
        dict = d
        return d
      })
  }
  return dictLoading
}

// ---------- model calls ----------

type CallResult = { ok: true; text: string } | { ok: false; reason: string }

function fromModelUsage(u: ModelUsage | undefined): CallUsage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  }
}

async function recordUsage($: $T, provider: OsmosisProvider, u: CallUsage) {
  const day = dayOf(await $.clock.now())
  await update($, usageAtom, usage => addUsage(usage, day, provider, u))
  isUsageDirty = true
}

async function setHealth($: $T, local: 'ok' | 'down') {
  const now = await read($, healthAtom)
  if (now.local !== local) await update($, healthAtom, () => ({ local }))
}

async function postLocal($: $T, url: string, body: string) {
  const timeout = $.clock.sleep(LOCAL_TIMEOUT_MS).then(() => null)
  const call = $.http
    .fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    .catch(() => null)
  return Promise.race([call, timeout])
}

async function callLocal($: $T, s: OsmosisSettings, system: string, prompt: string, schema: object, maxTokens: number): Promise<CallResult> {
  if (!isLocalUrl(s.endpoint)) {
    await setHealth($, 'down')
    return { ok: false, reason: 'local-bad-endpoint' }
  }
  let req = localRequest(s, system, prompt, schema, maxTokens)
  let res = await postLocal($, req.url, req.body)
  if (res && res.status === 400) {
    req = localRequest(s, system, prompt, null, maxTokens)
    res = await postLocal($, req.url, req.body)
  }
  if (!res || !res.ok) {
    await setHealth($, 'down')
    return { ok: false, reason: 'local-unreachable' }
  }
  await setHealth($, 'ok')
  const reply = parseLocalReply(res.text)
  if (!reply) return { ok: false, reason: 'local-bad-reply' }
  await recordUsage($, 'local', reply.usage)
  return { ok: true, text: reply.text }
}

async function callHaiku($: $T, prompt: string, isWords: boolean, maxTokens: number): Promise<CallResult> {
  const r = await $.model.complete({
    model: 'haiku',
    prompt: isWords ? [{ text: RULES, cache: true }, { text: prompt }] : prompt,
    ...(isWords ? {} : { system: EXAMPLE_SYSTEM }),
    maxTokens,
    timeoutMs: 60000,
  })
  await recordUsage($, 'haiku', fromModelUsage(r.usage))
  return r.isAnswered ? { ok: true, text: r.text } : { ok: false, reason: r.reason }
}

// ---------- the translation worker ----------

function remember(key: string, words: OsmosisWord[]) {
  cache.delete(key)
  cache.set(key, words)
  while (cache.size > CACHE_ITEMS) cache.delete(cache.keys().next().value as string)
}

async function settle($: $T, job: Job, words: OsmosisWord[], isFresh: boolean) {
  remember(job.key, words)
  rememberText(job.key, job.text)
  if (isFresh) isCacheDirty = true
  if (words.length > 0) {
    await update($, recentAtom, list =>
      [...list.filter(r => r.key !== job.key), ...words.map((word, index) => ({ key: job.key, index, word }))].slice(-60),
    )
    await update($, latestAtom, () => job.key)
    if (isFresh) {
      const now = await $.clock.now()
      const today = dayOf(now)
      await changeProgress($, p => {
        const seen = { ...p.seen }
        for (const w of words) {
          const was = seen[w.target]
          seen[w.target] = { n: (was?.n ?? 0) + 1, en: w.en, gloss: w.gloss, romanization: w.romanization, last: now }
        }
        const keys = Object.keys(seen)
        if (keys.length > MAX_SEEN) {
          keys.sort((a, b) => seen[a]!.last - seen[b]!.last)
          for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete seen[k]
        }
        const count = (p.today.date === today ? p.today.count : 0) + words.length
        return { ...p, seen, today: { date: today, count } }
      })
    }
  }
  await $.state.set({ ...TX, id: job.key }, { status: 'ok', words })
}

async function retryOrFail($: $T, job: Job, reason: string) {
  const n = (attempts.get(job.key) ?? 0) + 1
  attempts.set(job.key, n)
  if (n < 2 && !jobs.has(job.requestId)) {
    jobs.set(job.requestId, { ...job, updatedAt: 0 })
    return
  }
  await $.state.set({ ...TX, id: job.key }, { status: 'failed', reason })
}

async function translate($: $T, job: Job) {
  inflight++
  inflightKeys.add(job.key)
  try {
    const cap = swapCap(job.text, job.settings.density)
    if (cap === 0) return await settle($, job, [], true)
    const progress = await read($, progressAtom)
    const prompt = buildPrompt(job.text, job.settings, reviewLists(progress), cap)
    const r =
      job.settings.model === 'local'
        ? await callLocal($, job.settings, RULES, prompt, wordsSchema(cap), 3000)
        : await callHaiku($, prompt, true, 3000)
    if (!r.ok) return await retryOrFail($, job, r.reason)
    const isMandarin = langInfo(job.settings.lang).isMandarin
    const parsed = parseReply(r.text, job.text, { isMandarin, known: new Set(Object.keys(progress.known)), cap })
    if (!parsed.ok) return await retryOrFail($, job, parsed.reason)
    const d = isMandarin ? await ensureDict($) : EMPTY_DICT
    await settle($, job, isMandarin ? parsed.words.map(w => verifyWord(w, d)) : parsed.words, true)
  } catch {
    await retryOrFail($, job, 'error').catch(() => undefined)
  } finally {
    inflight--
    inflightKeys.delete(job.key)
  }
}

async function fetchExample($: $T, job: ExJob, s: OsmosisSettings) {
  exInflight.add(job.id)
  try {
    const prompt = examplePrompt(job.target, job.romanization, job.gloss, s)
    const r = s.model === 'local' ? await callLocal($, s, EXAMPLE_SYSTEM, prompt, EXAMPLE_SCHEMA, 400) : await callHaiku($, prompt, false, 400)
    const ex = r.ok ? parseExample(r.text) : null
    if (ex) {
      exCache.set(job.id, ex)
      isExampleDirty = true
      await $.state.set({ ...EX, id: job.id }, { status: 'ok', target: ex.target, romanization: ex.romanization, en: ex.en })
    } else {
      await $.state.set({ ...EX, id: job.id }, { status: 'failed' })
    }
  } catch {
    await $.state.set({ ...EX, id: job.id }, { status: 'failed' }).catch(() => undefined)
  } finally {
    exInflight.delete(job.id)
  }
}

async function tick($: $T) {
  if (isTicking) return
  isTicking = true
  try {
    await tickOnce($)
  } finally {
    isTicking = false
  }
}

async function tickOnce($: $T) {
  ticks++
  const now = await $.clock.now()
  const s = await read($, settingsAtom)
  const capped = isCapReached(await read($, usageAtom), dayOf(now), s)
  for (const job of [...exJobs.values()]) {
    if (exInflight.size > 0) break
    exJobs.delete(job.id)
    const hit = exCache.get(job.id)
    if (hit) await $.state.set({ ...EX, id: job.id }, { status: 'ok', target: hit.target, romanization: hit.romanization, en: hit.en })
    else if (!capped) void fetchExample($, job, s)
  }
  const ready = [...jobs.values()]
    .filter(j => !inflightKeys.has(j.key) && (cache.has(j.key) || now - j.updatedAt >= SETTLE_MS))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const job of ready) {
    const hit = cache.get(job.key)
    if (hit) {
      jobs.delete(job.requestId)
      await settle($, job, hit, false)
      continue
    }
    if (inflight >= MAX_INFLIGHT) break
    if (capped && job.settings.model === 'haiku') continue
    jobs.delete(job.requestId)
    void translate($, job)
  }
  if (jobs.size > MAX_JOBS) {
    const old = [...jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, jobs.size - MAX_JOBS)
    for (const j of old) jobs.delete(j.requestId)
  }
  if (isFallbackDirty) {
    isFallbackDirty = false
    const all = [...new Set([...fallbackByMsg.values()].flat())].slice(-200)
    await update($, fallbacksAtom, () => all)
  }
  if (ticks % 12 === 0) await flush($)
}

function noteFallbacks(msgKey: string, scopes: string[]) {
  const was = fallbackByMsg.get(msgKey) ?? []
  if (was.length === scopes.length && was.every((x, i) => x === scopes[i])) return
  fallbackByMsg.delete(msgKey)
  if (scopes.length) fallbackByMsg.set(msgKey, scopes)
  while (fallbackByMsg.size > 60) fallbackByMsg.delete(fallbackByMsg.keys().next().value as string)
  isFallbackDirty = true
}

// ---------- pane actions ----------

async function openPane($: $T) {
  const s = await read($, settingsAtom)
  await $.ui.open({ id: PANE, title: `Osmosis ${langInfo(s.lang).label}` })
}

async function wordsOf($: $T, key: string | null): Promise<OsmosisWord[]> {
  if (!key) return []
  const { value } = await $.state.get({ ...TX, id: key })
  return value?.status === 'ok' ? value.words : (cache.get(key) ?? [])
}

function exampleId(w: OsmosisWord): string {
  return hashText(`${w.target}|${w.gloss}`)
}

async function exampleFor($: $T, w: OsmosisWord, capped: boolean): Promise<ExampleView> {
  if (w.exampleTarget) return { status: 'ok', target: w.exampleTarget, romanization: w.exampleRomanization, en: w.exampleEn }
  const id = exampleId(w)
  const { value } = await $.state.get({ ...EX, id })
  if (value) return value
  const hit = exCache.get(id)
  if (hit) return { status: 'ok', ...hit }
  if (capped) return { status: 'cap' }
  if (!exInflight.has(id) && !exJobs.has(id)) exJobs.set(id, { id, target: w.target, romanization: w.romanization, gloss: w.gloss })
  return { status: 'loading' }
}

async function speak($: $T, w: OsmosisWord, example: string) {
  const say = async (text: string) => {
    if (!text) return
    try {
      await $.audio.speak(text, voice ? { voice } : {})
    } catch {
      await $.audio.speak(text)
    }
  }
  try {
    await say(w.target)
    await say(example)
  } catch {
    $.ui.toast('Osmosis: speech is not available here (it needs macOS).')
  }
}

function buildQuiz(progress: OsmosisProgress, recent: readonly { word: OsmosisWord }[]): OsmosisQuestion[] {
  const pool = new Map<string, { target: string; romanization: string; gloss: string; isSaved: boolean }>()
  for (const w of Object.values(progress.saved)) pool.set(w.target, { target: w.target, romanization: w.romanization, gloss: w.gloss, isSaved: true })
  for (const { word: w } of [...recent].reverse()) if (!pool.has(w.target)) pool.set(w.target, { target: w.target, romanization: w.romanization, gloss: w.gloss, isSaved: false })
  for (const [t, s] of Object.entries(progress.seen).sort((a, b) => b[1].last - a[1].last).slice(0, 80)) {
    if (!pool.has(t)) pool.set(t, { target: t, romanization: s.romanization, gloss: s.gloss, isSaved: false })
  }
  const all = [...pool.values()].filter(x => x.gloss)
  if (all.length < 4) return []
  const shuffle = <T,>(xs: T[]): T[] => {
    const a = [...xs]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j]!, a[i]!]
    }
    return a
  }
  const fresh = all.filter(x => !progress.known[x.target])
  const ordered = [...shuffle(fresh.filter(x => x.isSaved)), ...shuffle(fresh.filter(x => !x.isSaved)), ...shuffle(all.filter(x => progress.known[x.target]))]
  return ordered.slice(0, 5).map(q => {
    const others = shuffle(all.filter(x => x.target !== q.target && x.gloss !== q.gloss)).slice(0, 3)
    const choices = shuffle([q.target, ...others.map(o => o.target)])
    return { target: q.target, romanization: q.romanization, gloss: q.gloss, choices, answer: choices.indexOf(q.target) }
  })
}

async function startQuiz($: $T) {
  const progress = await read($, progressAtom)
  const recent = await read($, recentAtom)
  await update($, quizAtom, () => ({ questions: buildQuiz(progress, recent), index: 0, score: 0, feedback: '' }))
  await update($, viewAtom, () => 'quiz' as const)
}

function actions($: $T, key: string | null, words: readonly OsmosisWord[], example: string): PaneActions {
  return {
    speak: w => void speak($, w, example),
    toggleSave: w =>
      void changeProgress($, p => {
        const saved = { ...p.saved }
        if (saved[w.target]) delete saved[w.target]
        else saved[w.target] = w
        return { ...p, saved }
      }),
    toggleKnown: w =>
      void changeProgress($, p => {
        const known = { ...p.known }
        if (known[w.target]) delete known[w.target]
        else known[w.target] = true
        return { ...p, known }
      }),
    step: delta =>
      void update($, selectedAtom, sel => {
        if (!key || words.length === 0) return sel
        const at = sel && sel.key === key ? sel.index : -1
        return { key, index: (at + delta + words.length) % words.length }
      }),
    pick: i => void (key ? update($, selectedAtom, () => ({ key, index: i })) : undefined),
    close: () => void $.ui.close({ id: PANE }),
    home: () => void update($, viewAtom, () => 'home' as const),
    unsave: target =>
      void changeProgress($, p => {
        const saved = { ...p.saved }
        delete saved[target]
        return { ...p, saved }
      }),
    answer: choice =>
      void (async () => {
        const quiz = await read($, quizAtom)
        const q = quiz?.questions[quiz.index]
        if (!quiz || !q) return
        const isRight = choice === q.answer
        if (isRight) {
          await changeProgress($, p => {
            const n = (p.mastery[q.target] ?? 0) + 1
            const known = n >= 3 ? { ...p.known, [q.target]: true as const } : p.known
            return { ...p, mastery: { ...p.mastery, [q.target]: n }, known }
          })
        }
        const feedback = isRight
          ? `Right: ${q.target} ${q.romanization} = ${q.gloss}`
          : `Not quite: "${q.gloss}" is ${q.target} ${q.romanization}`
        await update($, quizAtom, cur =>
          cur ? { ...cur, index: cur.index + 1, score: cur.score + (isRight ? 1 : 0), feedback } : cur,
        )
      })(),
    retake: () => void startQuiz($),
    setSettings: patch => void changeSettings($, patch),
    openView: view => void (view === 'quiz' ? startQuiz($) : update($, viewAtom, () => 'bank' as const)),
  }
}

const CAPS = { off: 'off', '100k': '100k', '300k': '300k', '1m': '1m' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await loadAll($)
    } catch {
      // first run, or a store that cannot be read: defaults stand
    }
    try {
      await loadFinals($)
    } catch {
      // no history to read
    }
    try {
      await $.command.register({
        name: 'osmosis',
        description: 'Osmosis Chinese practice: open the word pane, or change settings',
        argumentHint: '[on|off|level|density|show|card|band|status|cap|copy|model|endpoint|bank|quiz|lang|help]',
        immediate: true,
      })
    } catch {
      // commands unavailable here
    }
    applyStatus($, await read($, settingsAtom))
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    $.clock.every(CLIP_MS, () => void watchClipboard($))
    void detectVoice($)
    return next(e)
  })

  on('ui.copy', async ($, e, next) => {
    try {
      const s = await read($, settingsAtom)
      if (s.isOn && s.copy === 'english') {
        const english = revertCopy(e.text, shownBlocks(), s.show)
        if (english !== null) return next({ ...e, text: english })
      }
    } catch {
      // copy as given
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      await flush($)
    } catch {
      // nothing to save
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answer = normText(e.answer)
    if (e.agentId === undefined && answer.length >= MIN_CHARS) {
      try {
        await update($, finalsAtom, list => [...list.filter(f => f !== answer), answer].slice(-MAX_FINALS))
      } catch {
        // the reply stays in English
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    if (e.props.isSummary || text.length < MIN_CHARS) return next(e)
    const s = await read($, settingsAtom)
    if (!s.isOn) return next(e)
    const key = keyFor(text, s)
    const { value: tx } = await $.state.get({ ...TX, id: key })
    if (tx?.status === 'failed') return next(e)
    const hit = tx === undefined ? cache.get(key) : undefined
    const isFinal = isFinalBlock(text, await read($, finalsAtom))
    if (
      tx === undefined &&
      (isFinal || hit !== undefined) &&
      e.props.onScreen !== null &&
      !inflightKeys.has(key) &&
      jobs.get(e.requestId)?.key !== key
    ) {
      jobs.set(e.requestId, { requestId: e.requestId, key, text, settings: s, updatedAt: await $.clock.now() })
    }
    const words = tx?.status === 'ok' ? tx.words : hit
    if (!words || words.length === 0) return next(e)
    rememberText(key, text)
    const segs = planMessage(text, words)
    if (!segs.some(seg => seg.kind === 'prose')) return next(e)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const pick = (index: number) =>
      void (async () => {
        await update($, selectedAtom, () => ({ key, index }))
        await update($, viewAtom, () => 'home' as const)
        await openPane($)
      })()
    const cards = s.card === 'bar' ? null : planCards(segs, words, s.show, e.viewport?.columns ?? 100, e.props.onScreen)
    if (cards) noteFallbacks(key, [...cards.entries()].filter(([, p]) => p.kind === 'bar').map(([i]) => scopeFor(key, i)))
    return drawMessage({ Box, Text, Button, Markdown }, segs, words, key, e.props.isFirstOfReply, s, pick, cards)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, settingsAtom)
    if (!s.isOn || !s.isBandOn || e.props.hasSurvey) return next(e)
    const recent = await read($, recentAtom)
    const progress = await read($, progressAtom)
    const today = dayOf(await $.clock.now())
    const count = progress.today.date === today ? progress.today.count : 0
    const usage = await read($, usageAtom)
    const health = await read($, healthAtom)
    const notice = isCapReached(usage, today, s)
      ? 'daily cap reached'
      : s.model === 'local' && health.local === 'down'
        ? 'local model unreachable'
        : ''
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    return drawBand({ Box, Text, Button, Markdown }, recent, s, count, e.props.bodyColumns, notice, await read($, fallbacksAtom))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = (({ Box, Text, Button, Markdown }) => ({ Box, Text, Button, Markdown }))($.ui.resolve(e))
    const s = await read($, settingsAtom)
    const view = await read($, viewAtom)
    const progress = await read($, progressAtom)
    if (view === 'bank') return drawBank(els, progress, actions($, null, [], ''))
    if (view === 'quiz') return drawQuiz(els, await read($, quizAtom), actions($, null, [], ''))
    const selected = await read($, selectedAtom)
    const latest = await read($, latestAtom)
    const key = selected?.key ?? latest
    const words = await wordsOf($, key)
    const index = selected && selected.key === key && selected.index < words.length ? selected.index : null
    const usage = await read($, usageAtom)
    const today = dayOf(await $.clock.now())
    const w = index === null ? undefined : words[index]
    const example: ExampleView | null = w ? await exampleFor($, w, isCapReached(usage, today, s)) : null
    const exampleText = example?.status === 'ok' ? example.target : ''
    const copyNote =
      clipTool === null
        ? 'Copy as English is unavailable: no clipboard tool found (pbpaste, wl-paste or xclip).'
        : 'Copied text pastes as English: Osmosis watches the clipboard only to revert its own swaps.'
    return drawHome(els, s, words, index, progress, actions($, key, words, exampleText), example, usage, today, copyNote)
  })

  on('command.run', { command: 'osmosis' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = (rest[0] ?? '').toLowerCase()
    const v = verb.toLowerCase()
    const usage =
      'Osmosis: /osmosis (open pane) · on|off · level beginner|intermediate|advanced · density low|normal|high · show hanzi|pinyin|both · card word|bar|both · band on|off · status on|off · cap off|100k|300k|1m · copy english|shown · model haiku|local · endpoint <url> · local-model <name> · bank · quiz · lang <name>'
    try {
      if (v === '') {
        await update($, viewAtom, () => 'home' as const)
        await update($, selectedAtom, () => null)
        await openPane($)
        const s = await read($, settingsAtom)
        return { text: `Osmosis pane opened (${s.isOn ? 'on' : 'off'}, ${s.level}, ${s.density} density).` }
      }
      if (v === 'on' || v === 'off') {
        await changeSettings($, { isOn: v === 'on' })
        return { text: `Osmosis is ${v}.` }
      }
      if (v === 'level' && (arg === 'beginner' || arg === 'intermediate' || arg === 'advanced')) {
        await changeSettings($, { level: arg })
        return { text: `Osmosis level: ${arg}.` }
      }
      if (v === 'density' && (arg === 'low' || arg === 'normal' || arg === 'high')) {
        await changeSettings($, { density: arg })
        return { text: `Osmosis density: ${arg}.` }
      }
      if (v === 'show' && (arg === 'hanzi' || arg === 'pinyin' || arg === 'both')) {
        await changeSettings($, { show: arg })
        return { text: `Osmosis shows ${arg === 'both' ? 'hanzi + pinyin' : arg}.` }
      }
      if (v === 'card' && (arg === 'word' || arg === 'bar' || arg === 'both')) {
        await changeSettings($, { card: arg })
        return { text: `Osmosis hover card: ${arg === 'word' ? 'at the word' : arg === 'bar' ? 'in the bar' : 'both'}.` }
      }
      if (v === 'status' && (arg === 'on' || arg === 'off')) {
        await changeSettings($, { isStatusOn: arg === 'on' })
        return { text: `Osmosis status line ${arg}.` }
      }
      if (v === 'band' && (arg === 'on' || arg === 'off')) {
        await changeSettings($, { isBandOn: arg === 'on' })
        return { text: `Osmosis hover band ${arg}.` }
      }
      if (v === 'cap' && arg in CAPS) {
        const cap = CAPS[arg as keyof typeof CAPS]
        await changeSettings($, { cap })
        return { text: `Osmosis daily cap: ${cap === 'off' ? 'off' : `${cap} Haiku tokens`}.` }
      }
      if (v === 'model' && (arg === 'haiku' || arg === 'local')) {
        const s = await changeSettings($, { model: arg })
        return { text: arg === 'haiku' ? 'Osmosis model: Claude Haiku.' : `Osmosis model: local, at ${s.endpoint}.` }
      }
      if (v === 'endpoint' && rest[0] && isLocalUrl(rest[0])) {
        await changeSettings($, { endpoint: rest[0].slice(0, 200) })
        return { text: `Osmosis local endpoint: ${rest[0].slice(0, 200)}.` }
      }
      if (v === 'local-model' && rest[0]) {
        await changeSettings($, { localModel: rest.join(' ').slice(0, 120) })
        return { text: `Osmosis local model name: ${rest.join(' ').slice(0, 120)}.` }
      }
      if (v === 'lang' && rest.length > 0) {
        const lang = rest.join(' ').slice(0, 40)
        await changeSettings($, { lang })
        return { text: `Osmosis language: ${langInfo(lang).name}.` }
      }
      if (v === 'copy' && (arg === 'english' || arg === 'shown')) {
        await changeSettings($, { copy: arg })
        return { text: arg === 'english' ? 'Osmosis copies swapped words as English.' : 'Osmosis copies text as shown.' }
      }
      if (v === 'bank') {
        await update($, viewAtom, () => 'bank' as const)
        await openPane($)
        const n = Object.keys((await read($, progressAtom)).saved).length
        return { text: `Osmosis word bank: ${n} saved.` }
      }
      if (v === 'quiz') {
        await startQuiz($)
        await openPane($)
        return { text: 'Osmosis quiz opened.' }
      }
      return { text: usage }
    } catch {
      return { text: 'Osmosis: that did not work. Try /osmosis help.' }
    }
  })
}

