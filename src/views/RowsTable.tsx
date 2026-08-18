import { useMemo, useState } from 'react'
import * as api from '../lib/api'
import { buildFileName } from '../lib/normalize'
import { toSheetRows, toXlsx } from '../lib/export'
import { printRows } from '../lib/printView'
import { OUTPUT_COLUMNS, type Invoice, type Master, type Row } from '../lib/types'

interface Props {
  rows: Row[]
  invoices: Invoice[]
  master: Master
  onChange: (rows: Row[]) => void
  pageCount?: number
  pagePreviews?: string[]
}

interface Col {
  key: string
  label: string
  width: number
  /**
   * select = 정해진 값 중에서 고른다. 목록에 없는 값이 필요하면 '직접 입력…' 으로
   *          전환해 새 값을 넣을 수 있다.
   */
  kind: 'text' | 'num' | 'select' | 'readonly'
  get: (r: Row) => string
  set?: (r: Row, v: string) => Row
  options?: (m: Master) => string[]
}

/** 목록에 없는 값을 직접 넣겠다는 표시. */
const CUSTOM = '\u0000custom'

const COLS: Col[] = [
  { key: 'date', label: 'DATE', width: 100, kind: 'text', get: (r) => r.date, set: (r, v) => ({ ...r, date: v }) },
  { key: 'invoiceNumber', label: 'Invoice_number', width: 136, kind: 'text', get: (r) => r.invoiceNumber, set: (r, v) => ({ ...r, invoiceNumber: v }) },
  {
    key: 'vendorName', label: 'Vendor_name', width: 200, kind: 'select',
    get: (r) => r.vendorName, set: (r, v) => ({ ...r, vendorName: v }),
    options: (m) => m.vendors.map((v) => v.canonicalName),
  },
  {
    key: 'coa', label: 'COA', width: 190, kind: 'select',
    get: (r) => r.coa, set: (r, v) => ({ ...r, coa: v }),
    options: (m) => m.coa,
  },
  { key: 'amount', label: 'AMT', width: 100, kind: 'num', get: (r) => r.amount.toFixed(2), set: (r, v) => ({ ...r, amount: toNum(v) }) },
  {
    key: 'payment', label: 'PAYMENT', width: 96, kind: 'select',
    get: (r) => r.payment, set: (r, v) => ({ ...r, payment: v as Row['payment'] }),
    options: () => ['CARD', 'CHECK', 'ACH'],
  },
  {
    key: 'cardId', label: 'CARD_ID', width: 110, kind: 'select',
    get: (r) => r.cardId, set: (r, v) => ({ ...r, cardId: v }),
    options: (m) => m.cards.map((c) => c.cardId),
  },
  {
    key: 'location', label: 'LOCATION', width: 100, kind: 'select',
    get: (r) => r.location, set: (r, v) => ({ ...r, location: v.toUpperCase() }),
    options: (m) => m.locations.map((l) => l.code),
  },
  { key: 'memo', label: 'Memo', width: 150, kind: 'text', get: (r) => r.memo, set: (r, v) => ({ ...r, memo: v }) },
  { key: 'pages', label: '페이지', width: 74, kind: 'readonly', get: (r) => r.sourcePages.join(',') },
  { key: 'fileName', label: 'FileName', width: 330, kind: 'readonly', get: (r) => buildFileName(r) },
]

const toNum = (v: string) => {
  const n = Number(v.replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

export function RowsTable({ rows, invoices, master, onChange, pagePreviews }: Props) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const [query, setQuery] = useState('')
  const [reviewOnly, setReviewOnly] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [lastClicked, setLastClicked] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [focusPages, setFocusPages] = useState<number[] | null>(null)
  // '직접 입력…' 으로 전환한 칸들 (행id:컬럼키)
  const [freeform, setFreeform] = useState<Set<string>>(new Set())

  const view = useMemo(() => {
    let out = rows
    if (reviewOnly) out = out.filter((r) => r.needsReview.length > 0)

    const q = query.trim().toLowerCase()
    if (q) {
      out = out.filter((r) => COLS.some((c) => c.get(r).toLowerCase().includes(q)))
    }

    if (sort) {
      const col = COLS.find((c) => c.key === sort.key)
      if (col) {
        out = [...out].sort((a, b) => {
          const av = col.get(a)
          const bv = col.get(b)
          const an = Number(av)
          const bn = Number(bv)
          const cmp =
            Number.isFinite(an) && Number.isFinite(bn) && av !== '' && bv !== ''
              ? an - bn
              : av.localeCompare(bv, 'ko')
          return cmp * sort.dir
        })
      }
    }
    return out
  }, [rows, query, sort, reviewOnly])

  const edit = (id: string, col: Col, value: string) => {
    if (!col.set) return
    onChange(
      rows.map((r) => {
        if (r.id !== id) return r
        const next = col.set!(r, value)
        next.needsReview = r.needsReview.filter((f) => f !== col.key)
        next.editedFields = r.editedFields.includes(col.key)
          ? r.editedFields
          : [...r.editedFields, col.key]
        return next
      }),
    )
  }

  // ── 행 선택 ──

  const allPicked = view.length > 0 && view.every((r) => picked.has(r.id))
  const targets = picked.size > 0 ? view.filter((r) => picked.has(r.id)) : view

  const toggle = (id: string, shift: boolean) => {
    const next = new Set(picked)
    if (shift && lastClicked) {
      // 마지막으로 누른 행부터 여기까지 한 번에 (엑셀의 Shift+클릭과 같다)
      const a = view.findIndex((r) => r.id === lastClicked)
      const b = view.findIndex((r) => r.id === id)
      if (a >= 0 && b >= 0) {
        const on = !picked.has(id)
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
          if (on) next.add(view[i].id)
          else next.delete(view[i].id)
        }
      }
    } else {
      next.has(id) ? next.delete(id) : next.add(id)
    }
    setPicked(next)
    setLastClicked(id)
  }

  const copy = async (withHeader: boolean) => {
    const lines: string[] = []
    if (withHeader) lines.push(COLS.filter((c) => c.key !== 'pages').map((c) => c.label).join('\t'))
    for (const r of targets) {
      lines.push(COLS.filter((c) => c.key !== 'pages').map((c) => c.get(r)).join('\t'))
    }
    await navigator.clipboard.writeText(lines.join('\n'))
    setToast(`${targets.length}행 복사됨${withHeader ? ' (헤더 포함)' : ''}`)
    setTimeout(() => setToast(null), 1800)
  }

  const saveXlsx = async () => {
    setError(null)
    try {
      const name = `invoices-${new Date().toISOString().slice(0, 10)}.xlsx`
      const saved = await api.saveFileAs(name, toXlsx(targets))
      if (saved) {
        setToast(`${targets.length}행을 엑셀 파일로 저장했습니다`)
        setTimeout(() => setToast(null), 2500)
      }
    } catch (err) {
      setError(String(err))
    }
  }

  const mismatches = invoices.filter((i) => i.splitCheck === 'mismatch')
  const reviewCount = rows.reduce((a, r) => a + r.needsReview.length, 0)
  const sum = targets.reduce((a, r) => a + r.amount, 0)

  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          placeholder="표 안에서 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 200 }}
        />
        <span className="badge">
          {picked.size > 0 ? `${picked.size}행 선택` : `${view.length}행`}
        </span>
        <span className="badge">합계 {sum.toFixed(2)}</span>
        <button
          className={reviewOnly ? 'primary' : ''}
          onClick={() => setReviewOnly((v) => !v)}
          title="비어 있거나 근거가 약한 칸이 있는 행만 봅니다"
        >
          확인 필요 {reviewCount}칸
        </button>
        {mismatches.length > 0 && <span className="badge err">합계 불일치 {mismatches.length}건</span>}
        {picked.size > 0 && <button onClick={() => setPicked(new Set())}>선택 해제</button>}

        <span className="spacer" />

        <button className="primary" onClick={() => copy(false)}>
          {picked.size > 0 ? `선택 ${picked.size}행` : '전체'} 복사
        </button>
        <button onClick={() => copy(true)} title="첫 줄에 컬럼 이름을 붙여서 복사">
          헤더 포함
        </button>
        <button onClick={saveXlsx} title="보이는 행(또는 선택한 행)을 엑셀 파일로 저장합니다">
          엑셀로 저장
        </button>
        <button
          onClick={() => printRows(targets, 'Invoice Extractor')}
          title="인쇄 대화상자에서 'PDF로 저장'을 고르면 PDF 가 됩니다"
        >
          PDF로 저장
        </button>
        <button
          disabled={saving}
          title="검토가 끝난 행을 장부에 넣습니다. 인터넷 없이도 저장됩니다."
          onClick={async () => {
            setSaving(true)
            setToast(null)
            setError(null)
            try {
              const left = targets.reduce((a, r) => a + r.needsReview.length, 0)
              if (left > 0 && !confirm(`확인이 필요한 칸이 ${left}개 있습니다. 그래도 장부에 넣을까요?`)) {
                return
              }
              const res = await api.saveRecordsLocal([...OUTPUT_COLUMNS], toSheetRows(targets))
              setToast(`장부에 ${res.saved}행 저장 · 시트 미반영 ${res.pending}행`)
              setTimeout(() => setToast(null), 4000)
            } catch (err) {
              setError(String(err))
            } finally {
              setSaving(false)
            }
          }}
        >
          {saving ? '저장 중…' : '장부에 저장'}
        </button>
      </div>

      {error && <div className="alert err" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
      {toast && <div className="alert ok">{toast}</div>}

      {mismatches.map((m) => (
        <div key={m.id} className="alert err">
          <b>{m.vendorName} {m.invoiceNumber}</b> — 분할 합계가 영수증 총액과 다릅니다. 인쇄된 총액{' '}
          {m.printedTotal?.toFixed(2)}, 행 합계 {((m.printedTotal ?? 0) + (m.splitDelta ?? 0)).toFixed(2)}{' '}
          (차이 {m.splitDelta?.toFixed(2)}). 원본 페이지 {m.sourcePages.join(', ')} 확인이 필요합니다.
        </div>
      ))}

      <div className="table-wrap sheet" style={{ maxHeight: '56vh' }}>
        <table>
          <thead>
            <tr>
              <th className="pick">
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={() =>
                    setPicked(allPicked ? new Set() : new Set(view.map((r) => r.id)))
                  }
                  title="전체 선택"
                />
              </th>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  style={{ width: c.width, minWidth: c.width }}
                  onClick={() =>
                    setSort((s) =>
                      s?.key !== c.key ? { key: c.key, dir: 1 } : s.dir === 1 ? { key: c.key, dir: -1 } : null,
                    )
                  }
                  title="클릭해서 정렬"
                >
                  {c.label}
                  <span className="sort">{sort?.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.id} className={picked.has(r.id) ? 'picked' : ''}>
                <td className="pick">
                  <input
                    type="checkbox"
                    checked={picked.has(r.id)}
                    onChange={() => {}}
                    onClick={(ev) => toggle(r.id, ev.shiftKey)}
                  />
                </td>
                {COLS.map((c) => {
                  const fromTable = r.sources?.[c.key] === 'table' && !r.editedFields.includes(c.key)
                  const cls = [
                    c.kind === 'num' ? 'num' : '',
                    r.needsReview.includes(c.key) ? 'review' : r.editedFields.includes(c.key) ? 'edited' : '',
                    fromTable ? 'from-table' : '',
                  ].filter(Boolean).join(' ')

                  if (c.kind === 'readonly') {
                    return (
                      <td key={c.key} className={cls}>
                        {c.key === 'pages' ? (
                          <button
                            className="pagebtn"
                            disabled={!pagePreviews?.length}
                            onClick={() => setFocusPages(r.sourcePages)}
                          >
                            {c.get(r) || '—'}
                          </button>
                        ) : (
                          <div className="ro mono" title={c.get(r)}>{c.get(r)}</div>
                        )}
                      </td>
                    )
                  }

                  if (c.kind === 'select') {
                    const opts = c.options!(master)
                    const val = c.get(r)
                    const cellKey = `${r.id}:${c.key}`
                    // 목록에 없는 값이거나 사용자가 직접 입력을 고른 칸은 입력창으로 바꾼다.
                    const typing = freeform.has(cellKey) || (val !== '' && !opts.includes(val))

                    return (
                      <td key={c.key} className={cls}>
                        {typing ? (
                          <input
                            autoFocus={freeform.has(cellKey)}
                            value={val}
                            placeholder="새 값 입력"
                            onChange={(ev) => edit(r.id, c, ev.target.value)}
                            onBlur={() => {
                              // 비운 채로 벗어나면 다시 목록으로 돌아간다.
                              if (!c.get(r)) {
                                const n = new Set(freeform)
                                n.delete(cellKey)
                                setFreeform(n)
                              }
                            }}
                          />
                        ) : (
                          <select
                            value={val}
                            title={fromTable ? '인보이스에 없어서 매핑 기준표에서 채운 값입니다' : undefined}
                            onChange={(ev) => {
                              if (ev.target.value === CUSTOM) {
                                setFreeform(new Set(freeform).add(cellKey))
                                return
                              }
                              edit(r.id, c, ev.target.value)
                            }}
                          >
                            <option value="">
                              {r.needsReview.includes(c.key) ? '— 확인 필요 —' : '—'}
                            </option>
                            {opts.map((o) => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                            <option value={CUSTOM}>직접 입력…</option>
                          </select>
                        )}
                      </td>
                    )
                  }

                  return (
                    <td key={c.key} className={cls}>
                      <input
                        className={c.key === 'invoiceNumber' ? 'mono' : undefined}
                        value={c.get(r)}
                        placeholder={r.needsReview.includes(c.key) ? '확인 필요' : ''}
                        onChange={(ev) => edit(r.id, c, ev.target.value)}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
            {view.length === 0 && (
              <tr>
                <td colSpan={COLS.length + 1} className="muted" style={{ padding: 16 }}>
                  조건에 맞는 행이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>


      <div className="small muted" style={{ marginTop: 6 }}>
        왼쪽 체크박스로 행 선택 · Shift+클릭으로 여러 행 한 번에 · 아무것도 선택 안 하면 보이는 행
        전체가 대상입니다 · 목록에 없는 값이 필요하면 '직접 입력…' 을 고르세요
        <span style={{ marginLeft: 10 }}>
          <span className="legend review" /> 확인 필요
          <span className="legend table" /> 매핑에서 채움
          <span className="legend edited" /> 직접 수정
        </span>
      </div>

      {focusPages && pagePreviews && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>원본 페이지 {focusPages.join(', ')}</h3>
            <span className="spacer" />
            <button onClick={() => setFocusPages(null)}>닫기</button>
          </div>
          <div className="pages">
            {focusPages.map((p) => (
              <figure key={p}>
                <a href={pagePreviews[p - 1]} target="_blank" rel="noreferrer">
                  <img src={pagePreviews[p - 1]} alt={`page ${p}`} />
                </a>
                <figcaption>p.{p}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
