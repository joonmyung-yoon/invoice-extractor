import { useEffect, useState } from 'react'
import * as api from '../lib/api'
import { normalize, reapply } from '../lib/normalize'
import { listArchive, saveToArchive, syncArchive } from '../lib/archive'
import { RowsTable } from './RowsTable'
import type { Invoice, Master, Row } from '../lib/types'

interface Props {
  master: Master
  reloadKey: number
}

interface JobRecord {
  id: string
  pdfName: string
  pageCount: number
  createdAt: string
  status: string
  error: string | null
  elapsedMs: number
  promptSnapshot: string
  payload: { rows?: Row[]; invoices?: Invoice[]; raw?: unknown }
}

export function HistoryView({ master, reloadKey }: Props) {
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [sel, setSel] = useState<JobRecord | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [archive, setArchive] = useState<{ total: number; pending: number } | null>(null)
  const [syncing, setSyncing] = useState(false)

  const reload = async () => {
    const list = (await api.listJobs()) as JobRecord[]
    setJobs(list)
    setSel((cur) => (cur ? list.find((j) => j.id === cur.id) ?? null : null))
  }

  useEffect(() => {
    void reload()
    void refreshArchive()
  }, [reloadKey])

  const refreshArchive = async () => {
    const r = await listArchive().catch(() => null)
    if (r) setArchive({ total: r.rows.length, pending: r.pending })
  }

  const rows = sel?.payload?.rows ?? []
  const invoices = sel?.payload?.invoices ?? []

  return (
    <>
      <h2>이력</h2>
      <p className="sub">이 PC 에 저장된 추출 기록입니다. 언제든 다시 열어 수정하고 내보낼 수 있습니다.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 14 }}>
        <div>
          {jobs.length === 0 && <div className="muted small">아직 기록이 없습니다.</div>}
          {jobs.map((j) => (
            <div key={j.id} className={`list-item ${sel?.id === j.id ? 'active' : ''}`}>
              <button className="nav-item" style={{ flex: 1, padding: 0 }} onClick={() => setSel(j)}>
                <div style={{ color: 'var(--text)' }}>{j.pdfName}</div>
                <div className="small muted">
                  {j.createdAt} · {j.pageCount}p ·{' '}
                  {j.status === 'done'
                    ? `${j.payload?.rows?.length ?? 0}행`
                    : j.status === 'error'
                      ? '실패'
                      : j.status === 'interrupted'
                        ? '중단됨'
                        : j.status}
                </div>
              </button>
              <button
                className="danger small"
                style={{ padding: '2px 8px' }}
                onClick={async () => {
                  await api.deleteJob(j.id)
                  if (sel?.id === j.id) setSel(null)
                  await reload()
                }}
              >
                삭제
              </button>
            </div>
          ))}
        </div>

        <div>
          {!sel && <div className="panel muted">왼쪽에서 기록을 선택하세요.</div>}
          {sel && (
            <>
              <div className="row" style={{ marginBottom: 10 }}>
                <b>{sel.pdfName}</b>
                <span className="badge">{sel.createdAt}</span>
                {sel.elapsedMs > 0 && <span className="badge">{Math.round(sel.elapsedMs / 1000)}초</span>}
                <span className="spacer" />
                <button onClick={() => setShowPrompt((v) => !v)}>
                  {showPrompt ? '프롬프트 닫기' : '사용된 프롬프트 보기'}
                </button>
              </div>

              {sel.error && <div className="alert err" style={{ whiteSpace: 'pre-wrap' }}>{sel.error}</div>}
              {note && <div className="alert ok">{note}</div>}

              {sel.payload?.raw != null && rows.length > 0 && (
                <div className="alert warn">
                  <div className="row">
                    <span>
                      매핑 기준표를 고쳤다면 이 기록에도 다시 적용할 수 있습니다.
                      직접 고치신 칸은 그대로 유지됩니다.
                    </span>
                    <span className="spacer" />
                    <button
                      onClick={async () => {
                        setNote(null)
                        const next = reapply(sel.payload.raw, master, rows)
                        const changed = next.rows.filter((r, i) => {
                          const o = rows[i]
                          return !o || JSON.stringify(r) !== JSON.stringify(o)
                        }).length
                        await api.saveJobPayload(sel.id, {
                          ...sel.payload,
                          rows: next.rows,
                          invoices: next.invoices,
                        })
                        await reload()
                        setNote(
                          changed > 0
                            ? `매핑을 다시 적용해 ${changed}행이 갱신되었습니다.`
                            : '바뀐 내용이 없습니다. 이미 최신 매핑이 적용되어 있습니다.',
                        )
                        setTimeout(() => setNote(null), 4000)
                      }}
                    >
                      매핑 다시 적용
                    </button>
                  </div>
                </div>
              )}

              {(sel.status === 'interrupted' || sel.status === 'error') && (
                <div className="alert warn">
                  <div className="row">
                    <span>
                      이 작업은 완료되지 않았습니다. 페이지 이미지가 남아 있으면 변환 없이 바로 다시
                      추출할 수 있습니다.
                    </span>
                    <span className="spacer" />
                    <button
                      className="primary"
                      disabled={retrying}
                      onClick={async () => {
                        setRetrying(true)
                        try {
                          await api.setJobStatus(sel.id, 'extracting')
                          // 예전 기록은 조각을 나누기 전에 만든 것이라 0번 조각만 있다.
                          const { result } = await api.runExtraction(sel.id, 0, sel.promptSnapshot)
                          const norm = normalize(result, master)
                          await api.saveJobPayload(sel.id, {
                            raw: result,
                            rows: norm.rows,
                            invoices: norm.invoices,
                          })
                          await reload()
                        } catch (err) {
                          await api.setJobStatus(sel.id, 'error', String(err)).catch(() => {})
                          await reload()
                        } finally {
                          setRetrying(false)
                        }
                      }}
                    >
                      {retrying ? '다시 추출 중…' : '다시 추출'}
                    </button>
                  </div>
                </div>
              )}

              <div className="panel" style={{ padding: '10px 12px' }}>
                <div className="row">
                  <b className="small">구글시트에 보관</b>
                  {archive && (
                    <>
                      <span className="badge">보관 {archive.total}행</span>
                      {archive.pending > 0 && (
                        <span className="badge warn">시트 미반영 {archive.pending}행</span>
                      )}
                    </>
                  )}
                  <span className="spacer" />
                  <button
                    disabled={!rows.length}
                    title="이 기록을 보관 목록에 넣습니다. 인터넷 없이도 저장됩니다."
                    onClick={async () => {
                      setNote(null)
                      try {
                        const r = await saveToArchive(rows, sel.pdfName)
                        await refreshArchive()
                        setNote(`보관에 ${r.saved}행 추가했습니다 (동일 ${r.unchanged}행).`)
                        setTimeout(() => setNote(null), 4000)
                      } catch (err) {
                        setNote(String(err))
                      }
                    }}
                  >
                    이 기록 보관
                  </button>
                  <button
                    className="primary"
                    disabled={syncing}
                    title="양쪽에 없는 기록을 서로 채웁니다."
                    onClick={async () => {
                      setSyncing(true)
                      setNote(null)
                      try {
                        const r = await syncArchive()
                        await refreshArchive()
                        setNote(
                          `동기화 완료 — 시트로 ${r.pushed}행, 시트에서 ${r.pulled}행` +
                            (r.conflicts ? ` · ⚠ 값이 다른 ${r.conflicts}행은 그대로 뒀습니다` : ''),
                        )
                        setTimeout(() => setNote(null), 6000)
                      } catch (err) {
                        setNote(String(err))
                      } finally {
                        setSyncing(false)
                      }
                    }}
                  >
                    {syncing ? '동기화 중…' : '구글시트와 동기화'}
                  </button>
                </div>
                <p className="muted small" style={{ margin: '6px 0 0' }}>
                  장부와 별개인 우리 작업 기록입니다. 메모·원본 PDF 이름까지 남으며
                  시트의 <code className="mono">History</code> 탭에 들어갑니다 — 장부용 복사에는
                  섞이지 않습니다.
                </p>
              </div>

              {showPrompt && (
                <div className="panel">
                  <textarea readOnly rows={16} value={sel.promptSnapshot} />
                </div>
              )}

              {rows.length > 0 ? (
                <RowsTable
                  rows={rows}
                  invoices={invoices}
                  master={master}
                  pageCount={sel.pageCount}
                  jobId={sel.id}
                  onChange={async (next) => {
                    await api.saveJobPayload(sel.id, { ...sel.payload, rows: next })
                    await reload()
                  }}
                />
              ) : (
                !sel.error && <div className="panel muted">저장된 행이 없습니다.</div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
