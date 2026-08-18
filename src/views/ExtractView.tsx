import { useEffect, useRef, useState } from 'react'
import { extraction, fmtElapsed, useExtraction, type Job } from '../lib/extractionStore'
import { runJob } from '../lib/runner'
import * as api from '../lib/api'
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
  const [, force] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const startedRef = useRef(new Set<string>())

  // 경과 시간이 멈춘 것처럼 보이지 않게 1초마다 다시 그린다.
  useEffect(() => {
    if (!st.jobs.some((j) => j.stage === 'rendering' || j.stage === 'extracting')) return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [st.jobs])

  // 큐를 돌린다. 동시에 도는 건수를 넘지 않게 하나씩 꺼내 시작한다.
  useEffect(() => {
    if (!prompt) return
    const active = st.jobs.filter((j) => j.stage === 'rendering' || j.stage === 'extracting').length
    if (active >= st.concurrency) return

    const next = st.jobs.find((j) => j.stage === 'queued' && !startedRef.current.has(j.id))
    if (!next) return

    startedRef.current.add(next.id)

    // 동시에 띄우는 claude 프로세스 총량을 일정하게 유지한다.
    // 너무 많이 띄우면 서로 느려지고 사용량 한도에도 걸린다(실측: 4개 동시에서
    // 개당 처리 속도가 2배 넘게 떨어졌다).
    const pending = st.jobs.filter(
      (j) => j.stage === 'queued' || j.stage === 'rendering' || j.stage === 'extracting',
    ).length
    const chunks = pending <= 1 ? 4 : Math.max(1, Math.floor(4 / st.concurrency))
    void runJob(next, master, prompt, chunks).then(onDone)
  }, [st.jobs, st.concurrency, prompt, master])

  const add = (files: FileList | File[]) => {
    const pdfs = Array.from(files).filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
    )
    if (!pdfs.length) return
    extraction.enqueue(pdfs)
  }

  const selected = st.jobs.find((j) => j.id === st.selectedId) ?? null
  const busy = st.jobs.some((j) => j.stage === 'rendering' || j.stage === 'extracting')

  const persist = async (next: Row[]) => {
    if (!selected) return
    extraction.patch(selected.id, { rows: next })
    if (selected.jobId) {
      await api
        .saveJobPayload(selected.jobId, {
          raw: selected.raw,
          rows: next,
          invoices: selected.invoices,
        })
        .catch(() => {})
    }
  }

  return (
    <>
      <h2>추출</h2>
      <p className="sub">
        PDF 를 여러 개 올려도 됩니다. 큐에 쌓아 두고 순서대로 처리하며, 다른 탭으로 옮겨도 계속
        진행됩니다.
      </p>

      {!master.vendors.length && (
        <div className="alert warn">
          매핑 기준표가 비어 있습니다. 설정에서 구글시트를 동기화하면 벤더명·결제수단·카드가
          자동으로 채워져 정확도가 크게 올라갑니다.
        </div>
      )}

      <div
        className={`drop compact ${over ? 'over' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          add(e.dataTransfer.files)
        }}
      >
        <div>PDF 를 여기에 놓거나 클릭해서 선택 · 여러 개 한꺼번에 가능</div>
        <div className="small">
          프롬프트: {prompt ? prompt.name : '없음'} · 매핑 벤더 {master.vendors.length}개
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) add(e.target.files)
          e.target.value = ''
        }}
      />

      {st.jobs.length > 0 && (
        <div className="row" style={{ margin: '10px 0' }}>
          <label className="muted small">동시 처리</label>
          <select
            value={st.concurrency}
            onChange={(e) => extraction.setConcurrency(Number(e.target.value))}
            style={{ width: 130 }}
            title="PDF 를 몇 건씩 동시에 처리할지. PDF 가 하나뿐이면 그 하나를 4조각으로 나눠 돌립니다."
          >
            <option value={1}>1건씩</option>
            <option value={2}>2건씩</option>
            <option value={3}>3건씩</option>
            <option value={4}>4건씩</option>
          </select>
          {busy && <span className="badge">{st.jobs.filter((j) => j.stage === 'queued').length}건 대기</span>}
          <span className="spacer" />
          {st.jobs.some((j) => j.stage === 'done' || j.stage === 'error') && (
            <button onClick={() => extraction.clearFinished()}>끝난 것 목록에서 치우기</button>
          )}
        </div>
      )}

      {st.jobs.map((j) => (
        <JobCard
          key={j.id}
          job={j}
          selected={j.id === st.selectedId}
          onSelect={() => extraction.select(j.id)}
        />
      ))}

      {selected?.stage === 'done' && (
        <>
          {selected.coverage && (
            <div className="alert warn">
              페이지 처리에 빠진 곳이 있습니다.
              {selected.coverage.missing.length > 0 && ` 누락: ${selected.coverage.missing.join(', ')}`}
              {selected.coverage.duplicated.length > 0 &&
                ` 중복: ${selected.coverage.duplicated.join(', ')}`}
            </div>
          )}

          {selected.unknownVendors.length > 0 && (
            <div className="alert warn">
              <b>매핑에 없는 벤더 {selected.unknownVendors.length}곳</b> — 구글시트 Vendors 탭에
              추가하면 다음부터 자동으로 채워집니다.
              <div style={{ marginTop: 6 }}>
                {selected.unknownVendors.map((u) => (
                  <div key={u.name} className="row small" style={{ marginTop: 4 }}>
                    <span className="mono">{u.name}</span>
                    <span className="muted">p.{u.pages.join(',')}</span>
                    <button
                      style={{ padding: '1px 8px' }}
                      onClick={() =>
                        api
                          .appendVendor([u.name, '', '', '', u.suggestedCoa, '자동 추가'])
                          .then(() =>
                            extraction.patch(selected.id, {
                              unknownVendors: selected.unknownVendors.filter(
                                (y) => y.name !== u.name,
                              ),
                            }),
                          )
                          .catch(() => {})
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
            rows={selected.rows}
            invoices={selected.invoices}
            master={master}
            onChange={persist}
            pageCount={selected.pageCount}
            pagePreviews={selected.previews}
            jobId={selected.jobId}
          />
        </>
      )}
    </>
  )
}

/** 작업 한 건의 진행 상황. */
function JobCard({
  job,
  selected,
  onSelect,
}: {
  job: Job
  selected: boolean
  onSelect: () => void
}) {
  const busy = job.stage === 'rendering' || job.stage === 'extracting'
  const elapsed = job.startedAt
    ? Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)
    : 0
  const total = Math.max(1, job.pageCount)

  // 변환이 앞 20%, 추출이 나머지 78%.
  const pct =
    job.stage === 'queued'
      ? 0
      : job.stage === 'rendering'
        ? (job.rendered / total) * 20
        : job.stage === 'done'
          ? 100
          : 20 + Math.min(job.pagesRead / total, 1) * 78

  // 페이지를 다 읽고도 결과가 안 나오는 구간이 길다. 그때 뭘 하는지 알려 준다.
  const allRead = job.stage === 'extracting' && job.pagesRead >= job.pageCount && job.pageCount > 0
  const remain =
    job.stage === 'extracting' && job.pagesRead > 0 && !allRead
      ? Math.round((elapsed / job.pagesRead) * (total - job.pagesRead))
      : null

  return (
    <div
      className={`panel jobcard ${selected ? 'sel' : ''} ${job.stage}`}
      onClick={onSelect}
      style={{ cursor: 'pointer' }}
    >
      <div className="row" style={{ marginBottom: busy ? 8 : 0 }}>
        <b>{job.fileName}</b>
        {job.pageCount > 0 && <span className="badge">{job.pageCount}페이지</span>}
        {job.stage === 'queued' && <span className="badge">대기 중</span>}
        {job.stage === 'done' && (
          <span className="badge ok">
            {job.invoices.length}건 / {job.rows.length}행
          </span>
        )}
        {job.stage === 'error' && <span className="badge err">실패</span>}
        <span className="spacer" />
        {elapsed > 0 && <span className="mono small muted">{fmtElapsed(elapsed)}</span>}
        <button
          className="small"
          style={{ padding: '2px 8px' }}
          onClick={(e) => {
            e.stopPropagation()
            extraction.remove(job.id)
          }}
          title="목록에서 치웁니다. 저장된 이력은 남습니다."
        >
          ✕
        </button>
      </div>

      {busy && (
        <>
          <div className="progress" style={{ marginBottom: 6 }}>
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="row small">
            <span className={`step ${job.stage === 'rendering' ? 'on' : 'done'}`}>
              1. 페이지 변환{' '}
              {job.stage === 'rendering' ? `${job.rendered}/${job.pageCount}` : '완료'}
            </span>
            <span className={`step ${job.stage === 'extracting' && !allRead ? 'on' : allRead ? 'done' : ''}`}>
              2. 인보이스 읽는 중{' '}
              {job.stage === 'extracting' && `${job.pagesRead}/${job.pageCount}`}
            </span>
            <span className={`step ${allRead ? 'on' : ''}`}>3. 정리·검산</span>
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            {allRead
              ? '읽기를 마치고 인보이스를 묶어 표로 정리하는 중입니다. 조금 더 걸립니다.'
              : job.phase || '시작하는 중…'}
            {remain !== null && ` · 남은 시간 약 ${fmtElapsed(remain)}`}
          </div>
        </>
      )}

      {job.stage === 'error' && (
        <div className="small" style={{ color: '#fca5a5', whiteSpace: 'pre-wrap', marginTop: 6 }}>
          {job.error}
        </div>
      )}
    </div>
  )
}
