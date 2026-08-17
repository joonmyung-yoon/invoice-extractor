import { useEffect, useMemo, useState } from 'react'
import * as api from '../lib/api'
import { OUTPUT_COLUMNS } from '../lib/types'

const HEADER = [...OUTPUT_COLUMNS]

interface Record {
  key: string
  values: string[]
  synced: boolean
}

/** MM/DD/YYYY → 정렬·비교가 가능한 YYYYMMDD 숫자. 못 읽으면 0. */
function dateKey(s: string): number {
  const m = (s ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return m ? Number(`${m[3]}${m[1]}${m[2]}`) : 0
}

export function LedgerView() {
  const [records, setRecords] = useState<Record[]>([])
  const [pending, setPending] = useState(0)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [unsyncedOnly, setUnsyncedOnly] = useState(false)
  const [sort, setSort] = useState<{ i: number; dir: 1 | -1 } | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.listRecordsLocal()
      setRecords(res.rows)
      setPending(res.pending)
      setSyncedAt(await api.getSetting('records_synced_at'))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const iDate = HEADER.indexOf('DATE')
  const iAmt = HEADER.indexOf('AMT')
  const iVendor = HEADER.indexOf('Vendor_name')

  const view = useMemo(() => {
    let out = records

    if (unsyncedOnly) out = out.filter((r) => !r.synced)

    const needle = q.trim().toLowerCase()
    if (needle) out = out.filter((r) => r.values.some((c) => (c ?? '').toLowerCase().includes(needle)))

    if (from || to) {
      const f = from ? Number(from.replace(/-/g, '')) : 0
      const t = to ? Number(to.replace(/-/g, '')) : 99999999
      out = out.filter((r) => {
        const k = dateKey(r.values[iDate])
        return k >= f && k <= t
      })
    }

    const s = sort ?? { i: iDate, dir: -1 as const } // 기본은 최신 날짜부터
    out = [...out].sort((a, b) => {
      const av = a.values[s.i] ?? ''
      const bv = b.values[s.i] ?? ''
      if (s.i === iDate) return (dateKey(av) - dateKey(bv)) * s.dir
      const an = Number(av)
      const bn = Number(bv)
      const cmp =
        Number.isFinite(an) && Number.isFinite(bn) && av !== '' && bv !== ''
          ? an - bn
          : av.localeCompare(bv, 'ko')
      return cmp * s.dir
    })
    return out
  }, [records, q, from, to, sort, unsyncedOnly, iDate])

  const total = useMemo(
    () => view.reduce((a, r) => a + (Number(r.values[iAmt]) || 0), 0),
    [view, iAmt],
  )

  const byVendor = useMemo(() => {
    const m = new Map<string, { n: number; sum: number }>()
    for (const r of view) {
      const k = r.values[iVendor] || '(없음)'
      const cur = m.get(k) ?? { n: 0, sum: 0 }
      m.set(k, { n: cur.n + 1, sum: cur.sum + (Number(r.values[iAmt]) || 0) })
    }
    return [...m.entries()].sort((a, b) => b[1].sum - a[1].sum).slice(0, 8)
  }, [view, iAmt, iVendor])

  const sync = async () => {
    setSyncing(true)
    setError(null)
    setNote(null)
    try {
      const res = await api.syncRecords(HEADER)
      await load()
      setNote(
        `동기화 완료 — 시트로 ${res.pushed}행 올림 · 시트에서 ${res.pulled}행 받음` +
          (res.conflicts ? ` · ⚠ 양쪽 값이 다른 ${res.conflicts}행은 그대로 뒀습니다` : ''),
      )
    } catch (e) {
      setError(String(e))
    } finally {
      setSyncing(false)
    }
  }

  const copyAll = async () => {
    await navigator.clipboard.writeText(
      [HEADER.join('\t'), ...view.map((r) => r.values.join('\t'))].join('\n'),
    )
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <h2>장부</h2>
      <p className="sub">
        확정된 내역입니다. 이 PC에 먼저 저장되므로 인터넷이나 시트 연결 없이도 조회할 수 있고,
        동기화하면 구글시트와 양쪽에 없는 내역을 서로 채웁니다.
      </p>

      {error && <div className="alert err" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
      {note && <div className="alert ok">{note}</div>}

      <div className="panel">
        <div className="row">
          <input
            placeholder="벤더·인보이스번호·지점 등 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <label className="muted small">기간</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 148 }} />
          <span className="muted">~</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 148 }} />
          <button
            onClick={() => {
              setQ(''); setFrom(''); setTo(''); setSort(null); setUnsyncedOnly(false)
            }}
          >
            초기화
          </button>
          <button onClick={load} disabled={loading}>{loading ? '…' : '새로고침'}</button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <span className="badge">{view.length}행 / 전체 {records.length}행</span>
        <span className="badge">합계 {total.toFixed(2)}</span>
        <button
          className={unsyncedOnly ? 'primary' : ''}
          onClick={() => setUnsyncedOnly((v) => !v)}
          disabled={!pending}
          title="아직 구글시트에 올라가지 않은 행"
        >
          시트 미반영 {pending}행
        </button>
        <span className="spacer" />
        <span className="muted small">
          {syncedAt ? `마지막 동기화 ${syncedAt}` : '아직 동기화한 적 없음'}
        </span>
        <button onClick={copyAll} disabled={!view.length}>
          {copied ? '복사됨 ✓' : '보이는 내역 복사'}
        </button>
        <button className="primary" onClick={sync} disabled={syncing}>
          {syncing ? '동기화 중…' : '구글시트와 동기화'}
        </button>
      </div>

      {byVendor.length > 0 && (
        <div className="panel">
          <h3>벤더별 합계 (상위 8)</h3>
          <div className="row" style={{ gap: 6 }}>
            {byVendor.map(([name, v]) => (
              <span key={name} className="badge" title={`${v.n}건`}>
                {name} · {v.sum.toFixed(2)}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="table-wrap grid" style={{ maxHeight: '56vh' }}>
        <table>
          <thead>
            <tr>
              <th className="rownum">#</th>
              <th style={{ width: 34 }} title="구글시트 반영 여부">↑</th>
              {HEADER.map((h, i) => (
                <th
                  key={h}
                  onClick={() =>
                    setSort((s) => (s?.i !== i ? { i, dir: 1 } : s.dir === 1 ? { i, dir: -1 } : null))
                  }
                >
                  {h}
                  <span className="sort">{sort?.i === i ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
                </th>
              ))}
              <th style={{ width: 48 }} />
            </tr>
          </thead>
          <tbody>
            {view.map((r, i) => (
              <tr key={r.key}>
                <td className="rownum">{i + 1}</td>
                <td style={{ textAlign: 'center' }} title={r.synced ? '시트 반영됨' : '시트 미반영'}>
                  <span className={r.synced ? 'dot ok' : 'dot pending'} />
                </td>
                {HEADER.map((_, c) => (
                  <td key={c}>
                    <div className="ro">{r.values[c] ?? ''}</div>
                  </td>
                ))}
                <td>
                  <button
                    className="pagebtn danger"
                    title="로컬 장부에서만 삭제합니다 (시트는 그대로)"
                    onClick={async () => {
                      if (!confirm('이 행을 로컬 장부에서 삭제할까요? 구글시트는 그대로 둡니다.')) return
                      await api.deleteRecordLocal(r.key)
                      await load()
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
            {!view.length && !loading && (
              <tr>
                <td colSpan={HEADER.length + 3} className="muted" style={{ padding: 16 }}>
                  {records.length
                    ? '조건에 맞는 내역이 없습니다.'
                    : '아직 장부가 비어 있습니다. 추출 화면에서 「장부에 저장」을 누르면 여기 쌓입니다.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
