import { useRef, useState } from 'react'
import * as api from '../lib/api'
import { loadPdf } from '../lib/pdf'
import { buildPrompt } from '../lib/defaultPrompt'
import { checkPageCoverage, normalize } from '../lib/normalize'
import { extraction, useExtraction } from '../lib/extractionStore'
import { RowsTable } from './RowsTable'
import type { Master, Prompt, Row } from '../lib/types'

interface Props {
  master: Master
  prompt: Prompt | null
  onDone: () => void
}

export function ExtractView({ master, prompt, onDone }: Props) {
  const st = useExtraction()
  const [over, setOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const start = async (file: File) => {
    if (!prompt) {
      extraction.set({ error: '사용할 프롬프트가 없습니다. 프롬프트 화면에서 하나를 선택해 주세요.', stage: 'error' })
      return
    }
    extraction.reset()
    extraction.set({ stage: 'rendering', pdfName: file.name, startedAt: Date.now() })

    let jobId: string | null = null
    try {
      const pdf = await loadPdf(await file.arrayBuffer())
      extraction.set({ progress: { done: 0, total: pdf.pageCount } })

      const body = buildPrompt(prompt.body, master)
      jobId = await api.createJob({
        pdfName: file.name,
        pdfPath: file.name,
        pageCount: pdf.pageCount,
        promptId: prompt.id,
        promptSnapshot: body,
      })
      extraction.set({ jobId })

      const base64: string[] = []
      const urls: string[] = []
      for (let p = 1; p <= pdf.pageCount; p++) {
        const img = await pdf.render(p)
        base64.push(img.data)
        urls.push(img.previewUrl)
        extraction.set({ progress: { done: p, total: pdf.pageCount }, previews: [...urls] })
      }
      pdf.destroy()

      await api.stagePages(jobId, base64)

      extraction.set({ stage: 'extracting' })
      await api.setJobStatus(jobId, 'extracting')
      const { result } = await api.runExtraction(jobId, body)

      const norm = normalize(result, master)
      const cov = checkPageCoverage(norm.invoices, pdf.pageCount)

      await api.saveJobPayload(jobId, { raw: result, rows: norm.rows, invoices: norm.invoices })

      extraction.set({
        stage: 'done',
        rows: norm.rows,
        invoices: norm.invoices,
        unknownVendors: norm.unknownVendors,
        coverage: cov.ok ? null : { missing: cov.missing, duplicated: cov.duplicated },
        elapsed: Math.round((Date.now() - (extraction.get().startedAt ?? Date.now())) / 1000),
      })
      onDone()
    } catch (err) {
      extraction.set({ stage: 'error', error: String(err) })
      if (jobId) await api.setJobStatus(jobId, 'error', String(err)).catch(() => {})
    }
  }

  const persist = async (next: Row[]) => {
    extraction.set({ rows: next })
    const id = extraction.get().jobId
    if (id) {
      await api.saveJobPayload(id, { rows: next, invoices: extraction.get().invoices }).catch(() => {})
    }
  }

  const busy = st.stage === 'rendering' || st.stage === 'extracting'

  return (
    <>
      <h2>추출</h2>
      <p className="sub">
        PDF 를 올리면 페이지를 이미지로 변환해 로컬 Claude Code 에 넘깁니다. 대화 세션은 남지 않습니다.
      </p>

      {!master.vendors.length && (
        <div className="alert warn">
          매핑 기준표가 비어 있습니다. 설정에서 구글시트를 동기화하면 벤더명·결제수단·카드가
          자동으로 채워져 정확도가 크게 올라갑니다.
        </div>
      )}

      {(st.stage === 'idle' || st.stage === 'error') && (
        <>
          <div
            className={`drop ${over ? 'over' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(ev) => {
              ev.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(ev) => {
              ev.preventDefault()
              setOver(false)
              const f = ev.dataTransfer.files[0]
              if (f?.type === 'application/pdf' || f?.name.toLowerCase().endsWith('.pdf')) void start(f)
              else extraction.set({ error: 'PDF 파일만 올릴 수 있습니다.', stage: 'error' })
            }}
          >
            <div style={{ fontSize: 15, marginBottom: 6 }}>PDF 를 여기에 놓거나 클릭해서 선택</div>
            <div className="small">
              사용할 프롬프트: {prompt ? prompt.name : '없음'} · 매핑 벤더 {master.vendors.length}개
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            style={{ display: 'none' }}
            onChange={(ev) => {
              const f = ev.target.files?.[0]
              if (f) void start(f)
              ev.target.value = ''
            }}
          />
        </>
      )}

      {st.error && <div className="alert err" style={{ whiteSpace: 'pre-wrap' }}>{st.error}</div>}

      {busy && (
        <div className="panel">
          <div className="row" style={{ marginBottom: 8 }}>
            <b>{st.pdfName}</b>
            <span className="spacer" />
            <span className="muted small">
              {st.stage === 'rendering'
                ? `페이지 변환 ${st.progress.done}/${st.progress.total}`
                : `Claude Code 추출 중… (${st.progress.total}페이지, 보통 페이지당 10~15초)`}
            </span>
          </div>
          <div className="progress">
            <div
              style={{
                width:
                  st.stage === 'rendering'
                    ? `${(st.progress.done / Math.max(1, st.progress.total)) * 100}%`
                    : '100%',
                opacity: st.stage === 'extracting' ? 0.5 : 1,
              }}
            />
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>
            다른 탭으로 옮겨도 계속 진행됩니다. 앱을 완전히 종료하면 중단됩니다.
          </p>
        </div>
      )}

      {st.stage === 'done' && (
        <>
          <div className="row" style={{ marginBottom: 10 }}>
            <b>{st.pdfName}</b>
            <span className="badge">
              {st.progress.total}페이지 → {st.invoices.length}건 / {st.rows.length}행
            </span>
            <span className="badge">{st.elapsed}초</span>
            <span className="spacer" />
            <button onClick={() => extraction.reset()}>새 PDF</button>
          </div>

          {st.coverage && (
            <div className="alert warn">
              페이지 처리에 빠진 곳이 있습니다.
              {st.coverage.missing.length > 0 && ` 누락: ${st.coverage.missing.join(', ')}`}
              {st.coverage.duplicated.length > 0 && ` 중복: ${st.coverage.duplicated.join(', ')}`}
            </div>
          )}

          {st.unknownVendors.length > 0 && (
            <div className="alert warn">
              <b>매핑에 없는 벤더 {st.unknownVendors.length}곳</b> — 구글시트 Vendors 탭에 추가하면
              다음부터 자동으로 채워집니다.
              <div style={{ marginTop: 6 }}>
                {st.unknownVendors.map((u) => (
                  <div key={u.name} className="row small" style={{ marginTop: 4 }}>
                    <span className="mono">{u.name}</span>
                    <span className="muted">p.{u.pages.join(',')}</span>
                    <button
                      style={{ padding: '1px 8px' }}
                      onClick={() =>
                        api
                          .appendVendor([u.name, '', '', '', u.suggestedCoa, '자동 추가'])
                          .then(() =>
                            extraction.set({
                              unknownVendors: extraction
                                .get()
                                .unknownVendors.filter((y) => y.name !== u.name),
                            }),
                          )
                          .catch((err) => extraction.set({ error: String(err) }))
                      }
                    >
                      시트에 추가
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <RowsTable
            rows={st.rows}
            invoices={st.invoices}
            master={master}
            onChange={persist}
            pageCount={st.progress.total}
            pagePreviews={st.previews}
          />
        </>
      )}
    </>
  )
}
