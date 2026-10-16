import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const TEXT =
  'I opened the computer and read the file. Then I wrote a short note for you.\n\n```ts\nconst computer = 1\n```'

const REPLY = JSON.stringify([
  {
    en: 'computer',
    occurrence: 1,
    target: '电脑',
    romanization: 'diànnǎo',
    pos: 'noun',
    gloss: 'computer',
    literal: '电 electric + 脑 brain',
    example_target: '我的电脑很快。',
    example_romanization: 'Wǒ de diànnǎo hěn kuài.',
    example_en: 'My computer is fast.',
    level: 1,
  },
])

const USAGE = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }
const MESSAGE = { component: 'AssistantMessage', props: { text: TEXT, isFirstOfReply: true } } as const
const SCROLL = { offset: 0, bodyRows: 3 }

type Node = { type?: string; key?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

function walk(tree: unknown, pick: (n: Node) => boolean): Node[] {
  const out: Node[] = []
  const visit = (n: unknown) => {
    if (typeof n !== 'object' || n === null) return
    const node = n as Node
    if (pick(node)) out.push(node)
    for (const c of node.children ?? []) visit(c)
  }
  visit(tree)
  return out
}

const hoverOf = (tree: unknown, key: string) => walk(tree, n => n.props?.key === key)[0]?.hover as { scope?: string } | undefined
const LOW_TEXT =
  [1, 2, 3, 4, 5, 6, 7].map(n => `- Item number ${n} is a plain line.`).join('\n') + '\n- I opened the computer and read the file.'

const DICT: Record<string, string> = {
  'sources.json': JSON.stringify({ files: ['cedict-0.tsv'], hsk: 'hsk.tsv' }),
  'cedict-0.tsv': [
    '电\tdiàn\telectric',
    '脑\tnǎo\tbrain',
    '电脑\tdiànnǎo\tcomputer',
    '构\tgòu\tto construct',
    '建\tjiàn\tto establish',
    '构建\tgòujiàn\tto construct (sth abstract)',
    '行\tháng\trow\txíng\tto walk',
  ].join('\n'),
  'hsk.tsv': '电脑\t1\n行\t4\n',
}

const EXAMPLE_REPLY = JSON.stringify({ example_target: '电脑坏了。', example_romanization: 'Diànnǎo huài le.', example_en: 'The computer broke.' })

type FetchAnswer = { status: number; text: string } | 'throw'
type WorldOptions = { history?: string[]; fetch?: (url: string, body: string) => FetchAnswer }

function world(on: On, reply: string | null, store: Record<string, unknown> = {}, opts: WorldOptions = {}) {
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on, store)
  const calls = { model: 0, example: 0, opened: [] as string[], fetched: [] as { url: string; body: string }[], status: [] as (string | undefined)[] }
  const history = opts.history ?? [TEXT, LOW_TEXT]
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({
    value: history.flatMap(text => [
      { role: 'user' as const, text: 'please', toolUses: [] },
      { role: 'assistant' as const, text, toolUses: [] },
    ]),
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'Tingting            zh_CN    # 你好\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.status', ($, e) => {
    calls.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', ($, e) => {
    const name = String(e.path).split('/').pop() ?? ''
    const text = DICT[name]
    return text === undefined ? { deny: `no ${name}` } : { value: text }
  })
  on('http.fetch', ($, e) => {
    const body = String(e.init?.body ?? '')
    calls.fetched.push({ url: e.url, body })
    const answer = opts.fetch ? opts.fetch(e.url, body) : 'throw'
    if (answer === 'throw') return { deny: 'connection refused' }
    return { value: { status: answer.status, ok: answer.status < 300, headers: {}, text: answer.text } }
  })
  on('ui.open', ($, e) => {
    calls.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('model.complete', ($, e) => {
    if (e.prompt.includes('EXAMPLE REQUEST')) {
      calls.example++
      return { value: { isAnswered: true as const, text: EXAMPLE_REPLY, usage: USAGE } }
    }
    calls.model++
    return reply === null
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
      : { value: { isAnswered: true as const, text: reply, usage: USAGE } }
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE-BAND</Text>
  })
  return { clock, calls }
}

test('the reply draws as the engine draws it while no translation exists', async ($, on) => {
  world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  expect(await ui.find({ text: 'ENGINE' })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
})

test('a translation in state draws a hover-scoped word button, on terminal and desktop', async ($, on) => {
  const { clock, calls } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'osmosis', surface, ...MESSAGE })
    await clock.advance(2000)
    await clock.settle()
    const word = await ui.find({ key: 'w-0' })
    expect(word?.type).toBe('Button')
    expect(word?.text).toContain('电脑')
    expect(hoverOf(await ui.drawn(), 'w-0')?.scope).toMatch(/^tw-[0-9a-f]{16}-0$/)
    expect(await ui.find({ text: 'ENGINE' })).toBeUndefined()
    expect(await ui.find({ type: 'Markdown', text: 'const computer' })).toBeDefined()
    await ui.unmount()
  }
  expect(calls.model).toBe(1)
})

const BAND = {
  plugin: 'osmosis',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} },
} as const

test('with the hover card at the word, the band shows only its status line', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  const band = await $.ui.mount(BAND)
  expect(walk(await band.drawn(), n => n.hover?.display === 'flex')).toHaveLength(0)
  expect(await band.find({ text: /Osmosis 中文 · beginner/ })).toBeDefined()
})

test('the band holds a hidden card under the same hover scope', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'osmosis', args: 'card both', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  const scope = hoverOf(await msg.drawn(), 'w-0')?.scope
  expect(scope).toBeDefined()
  const band = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} },
  })
  const card = walk(await band.drawn(), n => n.type === 'Box' && n.hover?.scope === scope)[0]
  expect(card?.props?.display).toBe('none')
  expect(card?.hover?.display).toBe('flex')
  expect(JSON.stringify(card)).toContain('电 electric + 脑 brain')
  expect(await band.find({ text: /Osmosis 中文 · beginner · 1 words today/ })).toBeDefined()
})

test('clicking a word opens the pane on that word', async ($, on) => {
  const { clock, calls } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  await msg.press({ key: 'w-0' })
  expect(calls.opened).toContain('osmosis')
  const pane = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'osmosis',
    props: { title: 'Osmosis 中文', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: SCROLL, view: {} },
  })
  expect(await pane.find({ text: 'My computer is fast.' })).toBeDefined()
  expect(await pane.find({ key: 'speak' })).toBeDefined()
  await pane.press({ key: 'save' })
  expect((await pane.find({ key: 'save' }))?.text).toContain('Unsave')
})

test('a failed model call leaves the reply as the engine draws it', async ($, on) => {
  const { clock, calls } = world(on, null)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(4000)
  await clock.settle()
  expect(calls.model).toBe(2)
  expect(await ui.find({ text: 'ENGINE' })).toBeDefined()
})

test('/osmosis off turns every hook back to the engine', async ($, on) => {
  world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({
    command: 'osmosis',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(r.text).toBe('Osmosis is off.')
  const band = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} },
  })
  expect(await band.find({ text: 'ENGINE-BAND' })).toBeDefined()
})

const savedWord = (target: string, gloss: string) => ({
  en: gloss, occurrence: 1, target, romanization: '', pos: 'noun', gloss, literal: '',
  exampleTarget: '', exampleRomanization: '', exampleEn: '', level: 1, start: 0, end: 1,
})

test('the quiz asks from saved words and a right answer adds mastery', async ($, on) => {
  const saved = Object.fromEntries(
    [['电脑', 'computer'], ['笔记', 'note'], ['文件', 'file'], ['朋友', 'friend']].map(([t, g]) => [t!, savedWord(t!, g!)]),
  )
  world(on, REPLY, { progress: { seen: {}, known: {}, saved, mastery: {}, today: { date: '', count: 0 } } })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'osmosis', args: 'quiz', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const pane = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'osmosis',
    props: { title: 'Osmosis 中文', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: SCROLL, view: {} },
  })
  const asked = (await pane.find({ type: 'Text', text: /^"/ }))?.text.replace(/"/g, '')
  const target = Object.values(saved).find(w => w.gloss === asked)?.target
  const choices = await pane.findAll({ type: 'Button', text: /^[\u4e00-\u9fff]+$/ })
  expect(choices).toHaveLength(4)
  const right = choices.find(c => c.text === target)
  await pane.press({ key: right!.key! })
  expect(await pane.find({ text: /^Right:/ })).toBeDefined()
  expect(await pane.find({ text: 'Question 2 of 4 · score 1' })).toBeDefined()
})

const PANE = {
  plugin: 'osmosis',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'osmosis',
  props: { title: 'Osmosis 中文', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: SCROLL, view: {} },
} as const

test('a press on a level button in the pane changes the setting', async ($, on) => {
  world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'level-beginner' }))?.props.variant).toBe('primary')
  await pane.press({ key: 'level-advanced' })
  expect((await pane.find({ key: 'level-advanced' }))?.props.variant).toBe('primary')
  expect((await pane.find({ key: 'level-beginner' }))?.props.variant).toBe('secondary')
  const band = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} },
  })
  expect(await band.find({ text: /Osmosis 中文 · advanced/ })).toBeDefined()
})

test('the on/off toggle in the pane turns the reply hook back to the engine', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  expect(await msg.find({ key: 'w-0' })).toBeDefined()
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'set-off' }))?.props.hotkey).toBe('o')
  await pane.press({ key: 'set-off' })
  expect((await pane.find({ key: 'set-off' }))?.props.variant).toBe('primary')
  await msg.redraw()
  expect(await msg.find({ text: 'ENGINE' })).toBeDefined()
  expect(await msg.find({ key: 'w-0' })).toBeUndefined()
})

const cardIn = (tree: unknown, index: number) => {
  const holder = walk(tree, n => n.type === 'Box' && n.props?.key === `k-${index}`)[0]
  const card = (holder?.children ?? []).find(c => (c as Node).type === 'Box' && (c as Node).props?.position === 'absolute') as Node | undefined
  return { holder, card }
}

test('a swapped word is a keyed Box holding a hidden absolute card that hover reveals', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', viewport: { columns: 100, rows: 40 }, ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  const tree = await msg.drawn()
  const { holder, card } = cardIn(tree, 0)
  expect(walk(holder, n => n.type === 'Button' && n.props?.key === 'w-0')).toHaveLength(1)
  expect(card?.props?.display).toBe('none')
  expect(card?.hover?.display).toBe('flex')
  expect(card?.props?.borderStyle).toBe('round')
  expect(JSON.stringify(card)).toContain('click for more')
  expect(hoverOf(tree, 'w-0')?.scope).toMatch(/^tw-/)
})

test('the card sits below a word on the first row and above a word lower down', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const first = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', viewport: { columns: 100, rows: 40 }, ...MESSAGE })
  const lowText = LOW_TEXT
  const low = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    viewport: { columns: 100, rows: 40 },
    component: 'AssistantMessage',
    props: { text: lowText, isFirstOfReply: true },
  })
  await clock.advance(2000)
  await clock.settle()
  await clock.advance(2000)
  await clock.settle()
  expect(cardIn(await first.drawn(), 0).card?.props?.top).toBe(1)
  const above = cardIn(await low.drawn(), 0).card
  expect(above?.props?.top).toBe(-6)
  expect(above?.props?.left).toBe(0)
})

test('with the hover card in the bar, the word draws no floating card', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'osmosis', args: 'card bar', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toBe('Osmosis hover card: in the bar.')
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  const tree = await msg.drawn()
  expect(walk(tree, n => n.props?.key === 'w-0')).toHaveLength(1)
  expect(walk(tree, n => n.props?.position === 'absolute')).toHaveLength(0)
})

const BUILD_TEXT = 'The build is green now. I fixed the failing check and pushed the change for you.'
const PANE_PROPS = {
  plugin: 'osmosis',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'osmosis',
  props: { title: 'Osmosis 中文', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: SCROLL, view: {} },
} as const
const BAND_PROPS = {
  plugin: 'osmosis',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: SCROLL, view: {} },
} as const
const item = (en: string, target: string, romanization: string, level: number | null, extra: Record<string, unknown> = {}) => ({
  en, occurrence: 1, target, romanization, pos: 'noun', gloss: en, level, ...extra,
})

async function settleAll(clock: { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }) {
  for (let i = 0; i < 3; i++) {
    await clock.advance(1500)
    await clock.settle()
  }
}

async function paneText(ui: { drawn: () => Promise<unknown> }) {
  const texts: string[] = []
  const visit = (n: unknown) => {
    if (typeof n === 'string') texts.push(n)
    else if (n && typeof n === 'object') for (const c of (n as Node).children ?? []) visit(c)
  }
  visit(await ui.drawn())
  return texts.join('')
}

test('only the final block of a reply is translated; a mid-turn block costs nothing', async ($, on) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const { clock, calls } = world(on, REPLY, {}, { history: [] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const mid = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Now checking the computer logs to see what went wrong there.', isFirstOfReply: true } })
  const last = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  expect(calls.model).toBe(0)
  await $.turn.complete({ answer: TEXT, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await settleAll(clock)
  expect(calls.model).toBe(1)
  expect(await last.find({ key: 'w-0' })).toBeDefined()
  expect(await mid.find({ text: 'ENGINE' })).toBeDefined()
})

test('the example sentence loads lazily when the pane opens a word', async ($, on) => {
  const { clock, calls } = world(on, JSON.stringify([item('computer', '电脑', 'diànnǎo', 1)]))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  expect(calls.example).toBe(0)
  await msg.press({ key: 'w-0' })
  const pane = await $.ui.mount(PANE_PROPS)
  expect(await pane.find({ text: 'loading example...' })).toBeDefined()
  await settleAll(clock)
  expect(calls.example).toBe(1)
  expect(await pane.find({ text: '电脑坏了。' })).toBeDefined()
  expect(await pane.find({ text: 'The computer broke.' })).toBeDefined()
})

test('the counter adds each call usage and the pane shows it', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  const pane = await $.ui.mount(PANE_PROPS)
  expect(await pane.find({ text: 'Today: 1 calls · 1.7k tokens (1.2k in / 500 out) · 7 days: 1.7k' })).toBeDefined()
})

test('at the daily cap no new translation starts and the band says so', async ($, on) => {
  const day = new Date(1_760_000_000_000).toISOString().slice(0, 10)
  const usage = { days: { [day]: { haiku: { calls: 50, input: 90_000, output: 10_000, cacheRead: 0, cacheWrite: 0 } } } }
  const { clock, calls } = world(on, REPLY, { settings: { cap: '100k' }, usage })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  expect(calls.model).toBe(0)
  expect(await msg.find({ text: 'ENGINE' })).toBeDefined()
  const band = await $.ui.mount(BAND_PROPS)
  expect(await band.find({ text: /daily cap reached/ })).toBeDefined()
})

test('CC-CEDICT fixes a wrong pinyin and HSK level; a word it lacks stays unverified', async ($, on) => {
  const reply = JSON.stringify([item('computer', '电脑', 'diannao', 3), item('note', '笔记', 'bǐjì', 2)])
  const { clock } = world(on, reply)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  await msg.press({ key: 'w-0' })
  const pane = await $.ui.mount(PANE_PROPS)
  const first = await paneText(pane)
  expect(first).toContain('diànnǎo')
  expect(first).toContain('HSK 1')
  expect(first).toContain('✓ CC-CEDICT')
  expect(first).toContain('电 electric + 脑 brain')
  await msg.press({ key: 'w-1' })
  const second = await paneText(pane)
  expect(second).toContain('bǐjì')
  expect(second).toContain('HSK 2')
  expect(second).toContain('unverified')
})

const localAnswer = (words: unknown[]) => ({
  status: 200,
  text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(words) } }], usage: { prompt_tokens: 300, completion_tokens: 80 } }),
})

test('the local provider sends a JSON-schema chat request and is corrected by CC-CEDICT', async ($, on) => {
  const words = [item('build', '构建', 'gòngjiàn', 1, { literal: 'build' })]
  const { clock, calls } = world(on, REPLY, { settings: { model: 'local' } }, { history: [BUILD_TEXT], fetch: () => localAnswer(words) })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', component: 'AssistantMessage', props: { text: BUILD_TEXT, isFirstOfReply: true } })
  await settleAll(clock)
  expect(calls.model).toBe(0)
  expect(calls.fetched[0]?.url).toBe('http://127.0.0.1:8080/v1/chat/completions')
  const body = JSON.parse(calls.fetched[0]!.body)
  expect(body.messages[0].role).toBe('system')
  expect(body.response_format.type).toBe('json_schema')
  expect(body.response_format.json_schema.schema.type).toBe('array')
  expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('literal')
  await msg.press({ key: 'w-0' })
  const pane = await $.ui.mount(PANE_PROPS)
  const text = await paneText(pane)
  expect(text).toContain('gòujiàn')
  expect(text).not.toContain('HSK 1')
  expect(text).toContain('构 construct + 建 establish')
  expect(text).toContain('Local model today: 1 calls · 380 tokens')
})

test('a local failure keeps the reply in English, never calls Haiku, and the band says so', async ($, on) => {
  const { clock, calls } = world(on, REPLY, { settings: { model: 'local' } }, { fetch: () => 'throw' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  expect(calls.model).toBe(0)
  expect(calls.fetched.length).toBeGreaterThan(0)
  expect(await msg.find({ text: 'ENGINE' })).toBeDefined()
  const band = await $.ui.mount(BAND_PROPS)
  expect(await band.find({ text: /local model unreachable/ })).toBeDefined()
})

test('the status line row hides and shows the status entry', async ($, on) => {
  const { calls } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(calls.status.at(-1)).toMatch(/中文 · beginner/)
  const pane = await $.ui.mount(PANE_PROPS)
  await pane.press({ key: 'status-off' })
  expect(calls.status.at(-1)).toBe(undefined)
  expect((await pane.find({ key: 'status-off' }))?.props.variant).toBe('primary')
  await pane.press({ key: 'level-advanced' })
  expect(calls.status.at(-1)).toBe(undefined)
  await pane.press({ key: 'status-on' })
  expect(calls.status.at(-1)).toMatch(/中文 · advanced/)
  const r = await $.command.run({ command: 'osmosis', args: 'status off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toBe('Osmosis status line off.')
  expect(calls.status.at(-1)).toBe(undefined)
})
