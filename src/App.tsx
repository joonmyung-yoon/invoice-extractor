import { useEffect, useState } from 'react'
import * as api from './lib/api'
import { DEFAULT_PROMPT } from './lib/defaultPrompt'
import { useExtraction } from './lib/extractionStore'
import { EMPTY_MASTER, type Master, type Prompt } from './lib/types'
import { ExtractView } from './views/ExtractView'
import { HistoryView } from './views/HistoryView'
import { PromptsView } from './views/PromptsView'
import { SettingsView } from './views/SettingsView'
import { ViewerWindow } from './views/ViewerWindow'

type Tab = 'extract' | 'prompts' | 'history' | 'settings'

const BUILTIN_ID = 'builtin-default'

export default function App() {
  // 원본 대조 창은 같은 번들을 쓰되 화면만 다르게 그린다.
  if (window.location.hash.startsWith('#viewer')) return <ViewerWindow />

  return <MainApp />
}

function MainApp() {
  const [tab, setTab] = useState<Tab>('extract')
  const [master, setMaster] = useState<Master>(EMPTY_MASTER)
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [activePromptId, setActivePromptId] = useState<string | null>(null)
  const [historyKey, setHistoryKey] = useState(0)
  const [ready, setReady] = useState(false)
  const ext = useExtraction()

  useEffect(() => {
    void (async () => {
      // 기본 프롬프트는 매 기동마다 최신 내용으로 맞춘다 (사용자 사본은 건드리지 않는다).
      await api.savePrompt({
        id: BUILTIN_ID,
        name: '기본 추출 프롬프트',
        body: DEFAULT_PROMPT,
        builtin: true,
      })
      const list = (await api.listPrompts()) as Prompt[]
      setPrompts(list)

      const saved = await api.getSetting('active_prompt_id')
      setActivePromptId(saved && list.some((p) => p.id === saved) ? saved : BUILTIN_ID)

      // 오프라인에서도 바로 쓰도록 캐시를 먼저 올리고, 되면 시트에서 갱신한다.
      setMaster(await api.cachedMaster().catch(() => EMPTY_MASTER))
      api.syncMaster().then(setMaster).catch(() => {})

      setReady(true)
    })()
  }, [])

  const choosePrompt = async (id: string) => {
    setActivePromptId(id)
    await api.setSetting('active_prompt_id', id)
    setPrompts((await api.listPrompts()) as Prompt[])
  }

  const activePrompt = prompts.find((p) => p.id === activePromptId) ?? null

  const nav: [Tab, string][] = [
    ['extract', '추출'],
    ['history', '이력'],
    ['prompts', '프롬프트'],
    ['settings', '설정'],
  ]

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>
          Invoice Extractor
          <span>SCR</span>
        </h1>
        {nav.map(([k, label]) => {
          // 추출은 탭을 옮겨도 계속 돌아간다. 어디에 있든 진행 중임이 보여야 한다.
          const busy = k === 'extract' && (ext.stage === 'rendering' || ext.stage === 'extracting')
          return (
            <button
              key={k}
              className={`nav-item ${tab === k ? 'active' : ''}`}
              onClick={() => setTab(k)}
            >
              {label}
              {busy && (
                <span className="spin" title={
                  ext.stage === 'rendering'
                    ? `페이지 변환 ${ext.progress.done}/${ext.progress.total}`
                    : '추출 중'
                } />
              )}
            </button>
          )
        })}
        <div className="foot">
          매핑 벤더 {master.vendors.length}개
          <br />
          {master.syncedAt ? `동기화 ${master.syncedAt.slice(5, 16)}` : '시트 미연결'}
        </div>
      </aside>

      <main className="main">
        {!ready ? (
          <div className="muted">불러오는 중…</div>
        ) : tab === 'extract' ? (
          <ExtractView
            master={master}
            prompt={activePrompt}
            onDone={() => setHistoryKey((k) => k + 1)}
          />
        ) : tab === 'history' ? (
          <HistoryView master={master} reloadKey={historyKey} />
        ) : tab === 'prompts' ? (
          <PromptsView master={master} activeId={activePromptId} onActive={choosePrompt} />
        ) : (
          <SettingsView master={master} onMaster={setMaster} />
        )}
      </main>
    </div>
  )
}
