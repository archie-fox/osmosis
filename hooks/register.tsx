import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  OsmosisProgress,
  OsmosisQuestion,
  OsmosisSettings,
  OsmosisWord,
} from '../types'
import {
  DEFAULT_SETTINGS,
  EMPTY_PROGRESS,
  MIN_CHARS,
  RULES,
  buildPrompt,
  dayOf,
  keyFor,
  langInfo,
  parseReply,
  pickVoice,
  planMessage,
  reviewLists,
  swapCap,
} from './core'
import { drawBand, drawBank, drawHome, drawMessage, drawQuiz } from './draw'
import type { PaneActions } from './draw'

const PANE = 'osmosis'
const SETTLE_MS = 1200
const TICK_MS = 400
const MAX_INFLIGHT = 2
const MAX_JOBS = 40
const CACHE_ITEMS = 500
const CACHE_CHARS = 2_500_000
const MAX_SEEN = 3000

const settingsAtom = atom({ plugin: 'osmosis', key: 'settings' } as const, DEFAULT_SETTINGS)
const recentAtom = atom({ plugin: 'osmosis', key: 'recent' } as const, [])
const latestAtom = atom({ plugin: 'osmosis', key: 'latest' } as const, null)
const selectedAtom = atom({ plugin: 'osmosis', key: 'selected' } as const, null)
const viewAtom = atom({ plugin: 'osmosis', key: 'view' } as const, 'home')
const quizAtom = atom({ plugin: 'osmosis', key: 'quiz' } as const, null)
const progressAtom = atom({ plugin: 'osmosis', key: 'progress' } as const, EMPTY_PROGRESS)
const TX = { plugin: 'osmosis', key: 'tx' } as const

type Job = { requestId: string; key: string; text: string; settings: OsmosisSettings; updatedAt: number }

type $T = EngineInterface

const jobs = new Map<string, Job>()
const inflightKeys = new Set<string>()
const attempts = new Map<string, number>()
const cache = new Map<string, OsmosisWord[]>()
let inflight = 0
let ticks = 0
let isCacheDirty = false
let isProgressDirty = false
let voice: string | undefined
let isTicking = false

// ---------- persistence ----------

async function loadAll($: $T) {
  const stored = (await $.store.get('settings')) as Partial<OsmosisSettings> | undefined
  await update($, settingsAtom, () => ({ ...DEFAULT_SETTINGS, ...(stored ?? {}) }))
  const progress = (await $.store.get('progress')) as Partial<OsmosisProgress> | undefined
  if (progress) await update($, progressAtom, () => ({ ...EMPTY_PROGRESS, ...progress }))
  const pairs = (await $.store.get('cache')) as [string, OsmosisWord[]][] | undefined
  if (Array.isArray(pairs)) for (const [k, words] of pairs) if (typeof k === 'string' && Array.isArray(words)) cache.set(k, words)
  const v = await $.store.get('voice')
  if (typeof v === 'string') voice = v
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
    $.ui.status(s.isOn ? `\u{1F331} ${langInfo(s.lang).label} · ${s.level}` : undefined)
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

// ---------- the translation worker ----------

function remember(key: string, words: OsmosisWord[]) {
  cache.delete(key)
  cache.set(key, words)
  while (cache.size > CACHE_ITEMS) cache.delete(cache.keys().next().value as string)
}

async function settle($: $T, job: Job, words: OsmosisWord[], isFresh: boolean) {
  remember(job.key, words)
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
    const r = await $.model.complete({
      model: 'haiku',
      prompt: [{ text: RULES, cache: true }, { text: buildPrompt(job.text, job.settings, reviewLists(progress), cap) }],
      maxTokens: 3000,
      timeoutMs: 60000,
    })
    if (!r.isAnswered) return await retryOrFail($, job, r.reason)
    const parsed = parseReply(r.text, job.text, {
      isMandarin: langInfo(job.settings.lang).isMandarin,
      known: new Set(Object.keys(progress.known)),
      cap,
    })
    if (!parsed.ok) return await retryOrFail($, job, parsed.reason)
    await settle($, job, parsed.words, true)
  } catch {
    await retryOrFail($, job, 'error').catch(() => undefined)
  } finally {
    inflight--
    inflightKeys.delete(job.key)
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
    jobs.delete(job.requestId)
    void translate($, job)
  }
  if (jobs.size > MAX_JOBS) {
    const old = [...jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, jobs.size - MAX_JOBS)
    for (const j of old) jobs.delete(j.requestId)
  }
  if (ticks % 12 === 0) await flush($)
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

async function speak($: $T, w: OsmosisWord) {
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
    await say(w.exampleTarget)
  } catch {
    $.ui.toast('Osmosis: speech is not available here.')
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

function actions($: $T, key: string | null, words: readonly OsmosisWord[]): PaneActions {
  return {
    speak: w => void speak($, w),
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

export const register: Register = on => {
  // ---------- events ----------

  on('session.start', async ($, e, next) => {
    try {
      await loadAll($)
    } catch {
      // first run, or a store that cannot be read: defaults stand
    }
    try {
      await $.command.register({
        name: 'osmosis',
        description: 'Osmosis Chinese practice: open the word pane, or change settings',
        argumentHint: '[on|off|level|density|show|card|band|bank|quiz|lang|help]',
        immediate: true,
      })
    } catch {
      // commands unavailable here
    }
    applyStatus($, await read($, settingsAtom))
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    void detectVoice($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await flush($)
    } catch {
      // nothing to save
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
    if (tx === undefined && e.props.onScreen !== null && !inflightKeys.has(key) && jobs.get(e.requestId)?.key !== key) {
      jobs.set(e.requestId, { requestId: e.requestId, key, text, settings: s, updatedAt: await $.clock.now() })
    }
    const words = tx?.status === 'ok' ? tx.words : hit
    if (!words || words.length === 0) return next(e)
    const segs = planMessage(text, words)
    if (!segs.some(seg => seg.kind === 'prose')) return next(e)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const pick = (index: number) =>
      void (async () => {
        await update($, selectedAtom, () => ({ key, index }))
        await update($, viewAtom, () => 'home' as const)
        await openPane($)
      })()
    return drawMessage({ Box, Text, Button, Markdown }, segs, words, key, e.props.isFirstOfReply, s, pick, e.viewport?.columns ?? 100, e.props.onScreen)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, settingsAtom)
    if (!s.isOn || !s.isBandOn || e.props.hasSurvey) return next(e)
    const recent = await read($, recentAtom)
    const progress = await read($, progressAtom)
    const today = dayOf(await $.clock.now())
    const count = progress.today.date === today ? progress.today.count : 0
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    return drawBand({ Box, Text, Button, Markdown }, recent, s, count, e.props.bodyColumns)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = (({ Box, Text, Button, Markdown }) => ({ Box, Text, Button, Markdown }))($.ui.resolve(e))
    const s = await read($, settingsAtom)
    const view = await read($, viewAtom)
    const progress = await read($, progressAtom)
    if (view === 'bank') return drawBank(els, progress, actions($, null, []))
    if (view === 'quiz') return drawQuiz(els, await read($, quizAtom), actions($, null, []))
    const selected = await read($, selectedAtom)
    const latest = await read($, latestAtom)
    const key = selected?.key ?? latest
    const words = await wordsOf($, key)
    const index = selected && selected.key === key && selected.index < words.length ? selected.index : null
    return drawHome(els, s, words, index, progress, actions($, key, words))
  })

  on('command.run', { command: 'osmosis' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = (rest[0] ?? '').toLowerCase()
    const v = verb.toLowerCase()
    const usage =
      'Osmosis: /osmosis (open pane) · on|off · level beginner|intermediate|advanced · density low|normal|high · show hanzi|pinyin|both · card word|bar|both · band on|off · bank · quiz · lang <name>'
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
      if (v === 'band' && (arg === 'on' || arg === 'off')) {
        await changeSettings($, { isBandOn: arg === 'on' })
        return { text: `Osmosis hover band ${arg}.` }
      }
      if (v === 'lang' && rest.length > 0) {
        const lang = rest.join(' ').slice(0, 40)
        await changeSettings($, { lang })
        return { text: `Osmosis language: ${langInfo(lang).name}.` }
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

