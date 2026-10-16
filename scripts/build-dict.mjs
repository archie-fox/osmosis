#!/usr/bin/env node
// Rebuilds data/ from CC-CEDICT (MDBG) and the HSK 2.0 word lists.
// Usage: node scripts/build-dict.mjs [--src <folder with already-downloaded sources>]
// Plain Node 18+, no dependencies.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CEDICT_URL = 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz'
const HSK_COMMIT = '7ac65bf1a6387d35f1ade478906172a19311c7f9'
const HSK_URL = n =>
  `https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/${HSK_COMMIT}/wordlists/exclusive/old/${n}.json`
const MAX_FILE = 3_500_000
const GLOSS_MAX = 40

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'data')
const srcArg = process.argv.indexOf('--src')
const src = srcArg > 0 ? process.argv[srcArg + 1] : null

async function load(name, url) {
  if (src && existsSync(join(src, name))) return readFileSync(join(src, name))
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const TONES = { a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ' }

function markSyllable(token) {
  const m = /^([A-Za-z:]+?)([1-5])$/.exec(token)
  if (!m) return token
  const base = m[1].replace(/u:/g, 'ü').replace(/U:/g, 'Ü')
  const tone = Number(m[2])
  if (tone === 5) return base
  const lower = base.toLowerCase()
  let at = lower.indexOf('a')
  if (at < 0) at = lower.indexOf('e')
  if (at < 0 && lower.includes('ou')) at = lower.indexOf('o')
  if (at < 0) {
    for (let i = lower.length - 1; i >= 0; i--) {
      if ('iouü'.includes(lower[i])) {
        at = i
        break
      }
    }
  }
  if (at < 0) return base
  const marked = TONES[lower[at]][tone - 1]
  const ch = base[at] === lower[at] ? marked : marked.toUpperCase()
  return base.slice(0, at) + ch + base.slice(at + 1)
}

export function toToneMarks(numeric) {
  let outText = ''
  let prevWasSyllable = false
  for (const token of numeric.trim().split(/\s+/)) {
    if (!/[A-Za-z]/.test(token)) {
      outText += token === ',' || token === '，' ? ', ' : token === '·' ? ' · ' : token
      prevWasSyllable = false
      continue
    }
    const syl = markSyllable(token)
    const needsMark = prevWasSyllable && /^[aeoāáǎàēéěèōóǒòAEO]/.test(syl)
    outText += (needsMark ? "'" : '') + syl
    prevWasSyllable = true
  }
  return outText.replace(/\s+/g, ' ').trim()
}

const SKIP_SENSE = /^(variant of|old variant|archaic variant|see |used in|also written|abbr\. for|CL:|Taiwan pr\.)/

const clean = sense => sense.replace(/^(\([^)]*\)\s*)+/, '').trim()

function shortGloss(senses) {
  const cleaned = senses.map(clean).filter(Boolean)
  const good = cleaned.find(s => !SKIP_SENSE.test(s)) ?? cleaned[0] ?? ''
  const first = good.split('; ')[0].trim()
  return first.length > GLOSS_MAX ? `${first.slice(0, GLOSS_MAX - 1)}…` : first
}

const isJunk = gloss => !gloss || SKIP_SENSE.test(gloss)
const isPlainFirst = senses => Boolean(senses[0]) && !/^\(/.test(senses[0]) && !SKIP_SENSE.test(senses[0])

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

async function main() {
  const gz = await load('cedict.txt.gz', CEDICT_URL)
  const text = gunzipSync(gz).toString('utf8')
  const date = /^#! date=(.+)$/m.exec(text)?.[1] ?? 'unknown'
  const words = new Map()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/.exec(line)
    if (!m) continue
    const simp = m[2]
    if (!CJK.test(simp)) continue
    const reading = toToneMarks(m[3])
    const senses = m[4].split('/')
    const gloss = shortGloss(senses).replace(/\t/g, ' ')
    const plain = isPlainFirst(senses)
    const list = words.get(simp) ?? []
    const same = list.find(r => r.reading.toLowerCase() === reading.toLowerCase())
    if (same) {
      if ((isJunk(same.gloss) && !isJunk(gloss)) || (!same.plain && plain)) Object.assign(same, { gloss, plain })
    } else list.push({ reading, gloss, plain })
    words.set(simp, list)
  }

  const hsk = new Map()
  for (let n = 1; n <= 6; n++) {
    const list = JSON.parse((await load(`hsk-old-${n}.json`, HSK_URL(n))).toString('utf8'))
    for (const item of list) if (!hsk.has(item.simplified)) hsk.set(item.simplified, n)
  }

  mkdirSync(out, { recursive: true })
  for (const f of readdirSync(out)) if (/^cedict-\d+\.tsv$/.test(f)) unlinkSync(join(out, f))
  const files = []
  let rows = []
  let bytes = 0
  const flush = () => {
    if (rows.length === 0) return
    const name = `cedict-${files.length}.tsv`
    writeFileSync(join(out, name), rows.join(''))
    files.push(name)
    rows = []
    bytes = 0
  }
  for (const [simp, list] of [...words.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const row = [simp, ...list.flatMap(r => [r.reading, r.gloss])].join('\t') + '\n'
    const size = Buffer.byteLength(row)
    if (bytes + size > MAX_FILE) flush()
    rows.push(row)
    bytes += size
  }
  flush()
  const hskText = [...hsk.entries()].map(([w, n]) => `${w}\t${n}`).join('\n') + '\n'
  writeFileSync(join(out, 'hsk.tsv'), hskText)
  const sources = {
    files,
    hsk: 'hsk.tsv',
    cedict: { url: CEDICT_URL, date, license: 'CC BY-SA 4.0', words: words.size },
    hskList: {
      url: `https://github.com/drkameleon/complete-hsk-vocabulary/tree/${HSK_COMMIT}/wordlists/exclusive/old`,
      license: 'MIT',
      words: hsk.size,
    },
  }
  writeFileSync(join(out, 'sources.json'), JSON.stringify(sources, null, 2) + '\n')
  console.log(`data/: ${files.join(', ')}, hsk.tsv (${hsk.size} words), ${words.size} dictionary words, CC-CEDICT ${date}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
