export type OsmosisLevel = 'beginner' | 'intermediate' | 'advanced'
export type OsmosisDensity = 'low' | 'normal' | 'high'
export type OsmosisShow = 'hanzi' | 'both' | 'pinyin'
export type OsmosisCard = 'word' | 'bar' | 'both'

export type OsmosisSettings = {
  isOn: boolean
  level: OsmosisLevel
  density: OsmosisDensity
  show: OsmosisShow
  isBandOn: boolean
  card: OsmosisCard
  lang: string
}

export type OsmosisWord = {
  en: string
  occurrence: number
  target: string
  romanization: string
  pos: string
  gloss: string
  literal: string
  exampleTarget: string
  exampleRomanization: string
  exampleEn: string
  level: number | null
  start: number
  end: number
}

export type OsmosisTx =
  | { status: 'ok'; words: OsmosisWord[] }
  | { status: 'failed'; reason: string }

export type OsmosisRecentWord = { key: string; index: number; word: OsmosisWord }

export type OsmosisSelection = { key: string; index: number }

export type OsmosisView = 'home' | 'bank' | 'quiz'

export type OsmosisQuestion = {
  target: string
  romanization: string
  gloss: string
  choices: string[]
  answer: number
}

export type OsmosisQuiz = {
  questions: OsmosisQuestion[]
  index: number
  score: number
  feedback: string
}

export type OsmosisSeen = {
  n: number
  en: string
  gloss: string
  romanization: string
  last: number
}

export type OsmosisProgress = {
  seen: Record<string, OsmosisSeen>
  known: Record<string, true>
  saved: Record<string, OsmosisWord>
  mastery: Record<string, number>
  today: { date: string; count: number }
}

declare module 'claude-code' {
  interface PluginState {
    osmosis: {
      settings: OsmosisSettings
      tx: StateFamily<OsmosisTx>
      recent: OsmosisRecentWord[]
      latest: string | null
      selected: OsmosisSelection | null
      view: OsmosisView
      quiz: OsmosisQuiz | null
      progress: OsmosisProgress
    }
  }
}
