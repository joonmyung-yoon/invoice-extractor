import { useEffect, useState } from 'react'
import * as api from './lib/api'
import { DEFAULT_PROMPT } from './lib/defaultPrompt'
import { useExtraction } from './lib/extractionStore'
import { recoverUnfinished } from './lib/recover'
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
  const [recovered, setRecovered] = useState<{ pdfName: string; rows: number }[]>([])
  // 동기화 실패를 삼키면 "연결이 안 된다" 만 보이고 왜인지는 알 수 없다.
  const [syncError, setSyncError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
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
      void refreshMaster()

      setReady(true)

      // 지난번에 앱이 강제로 꺼졌다면 결과가 디스크에 남아 있을 수 있다.
      const m = await api.cachedMaster().catch(() => EMPTY_MASTER)
      const got = await recoverUnfinished(m).catch(() => [])
      if (got.length) {
        setRecovered(got)
        setHistoryKey((k) => k + 1)
      }
    })()
  }, [])

  /** 시트에서 매핑을 다시 받아온다. 실패하면 이유를 화면에 남긴다. */
  const refreshMaster = async () => {
    setRetrying(true)
    try {
      setMaster(await api.syncMaster())
      setSyncError(null)
    } catch (err) {
      setSyncError(String(err))
    } finally {
      setRetrying(false)
    }
  }

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
          const running = ext.jobs.filter(
            (j) => j.stage === 'rendering' || j.stage === 'extracting',
          ).length
          const waiting = ext.jobs.filter((j) => j.stage === 'queued').length
          const busy = k === 'extract' && running > 0
          return (
            <button
              key={k}
              className={`nav-item ${tab === k ? 'active' : ''}`}
              onClick={() => setTab(k)}
            >
              {label}
              {busy && (
                <span
                  className="spin"
                  title={`${running}건 처리 중${waiting ? ` · ${waiting}건 대기` : ''}`}
                />
              )}
              {busy && waiting > 0 && <span className="qbadge">{waiting}</span>}
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
        {syncError && (
          <div className="alert err" style={{ whiteSpace: 'pre-wrap' }}>
            <b>구글시트에서 매핑 기준표를 받아오지 못했습니다.</b>
            <div style={{ margin: '6px 0' }}>{syncError}</div>
            <div className="row small">
              <span className="muted">
                마지막으로 받아 둔 내용(벤더 {master.vendors.length}개)으로 계속 쓸 수 있습니다.
              </span>
              <span className="spacer" />
              <button disabled={retrying} onClick={refreshMaster}>
                {retrying ? '다시 시도 중…' : '다시 시도'}
              </button>
              <button onClick={() => setSyncError(null)}>닫기</button>
            </div>
          </div>
        )}
        {recovered.length > 0 && (
          <div className="alert ok">
            지난번에 끝내지 못한 추출 {recovered.length}건을 되살렸습니다 —{' '}
            {recovered.map((r) => `${r.pdfName} (${r.rows}행)`).join(', ')}. 이력 탭에서 볼 수 있습니다.
            <button style={{ marginLeft: 8, padding: '1px 8px' }} onClick={() => setRecovered([])}>
              닫기
            </button>
          </div>
        )}
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
