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

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
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

function world(on: On, reply: string | null, store: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on, store)
  const calls = { model: 0, opened: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'Tingting            zh_CN    # 你好\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    calls.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('model.complete', () => {
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

test('the band holds a hidden card under the same hover scope', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
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
