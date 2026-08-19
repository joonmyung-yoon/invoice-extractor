import { useEffect, useState } from 'react'
import * as api from '../lib/api'
import { MASTER_SEED, SHEET_TABS } from '../lib/masterSeed'
import type { Master } from '../lib/types'

interface Props {
  master: Master
  onMaster: (m: Master) => void
}

export function SettingsView({ master, onMaster }: Props) {
  const [claude, setClaude] = useState<string>('확인 중…')
  const [claudePath, setClaudePath] = useState('')
  const [email, setEmail] = useState<string | null>(null)
  const [sheetUrl, setSheetUrl] = useState('')
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [stats, setStats] = useState<api.StorageStats | null>(null)
  const [purgeDays, setPurgeDays] = useState('90')
  // 새 벤더 직접 추가
  const [nv, setNv] = useState({ name: '', aliases: '', payment: '', card: '', coa: '', notes: '' })
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    api.claudeStatus().then(setClaude).catch((e) => setClaude(`❌ ${e}`))
    api.serviceAccountEmail().then(setEmail).catch(() => {})
    api.getSetting('sheet_url').then((v) => setSheetUrl(v ?? ''))
    api.getSetting('claude_path').then((v) => setClaudePath(v ?? ''))
    api.dataDir().then(setDir)
    void loadStats()
  }, [])

  const loadStats = async () => {
    try {
      setStats(await api.storageStats())
    } catch {
      /* 용량 조회 실패가 앱 사용을 막을 이유는 없다 */
    }
  }

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg({ kind: 'err', text: String(e) })
    } finally {
      setBusy(null)
    }
  }

  const pickKey = async (file: File) => {
    const text = await file.text()
    await run('key', async () => {
      const e = await api.saveServiceAccountKey(text)
      setEmail(e)
      setMsg({ kind: 'ok', text: `키를 저장했습니다. 이 시트를 ${e} 에 편집자로 공유해 주세요.` })
    })
  }

  return (
    <>
      <h2>설정</h2>
      <p className="sub">
        PDF·페이지 이미지·추출 이력은 이 PC 안에만 있습니다. 구글시트에는 매핑 기준표와, 동기화를
        눌렀을 때의 확정 내역(장부)만 올라갑니다.
      </p>

      {msg && <div className={`alert ${msg.kind === 'ok' ? 'ok' : 'err'}`}>{msg.text}</div>}

      <div className="panel">
        <h3>Claude Code</h3>
        <div className="mono small" style={{ marginBottom: 10 }}>{claude}</div>
        <div className="field">
          <label>실행 파일 경로 (자동으로 못 찾을 때만 입력)</label>
          <div className="row">
            <input
              className="mono"
              placeholder="/Users/이름/.local/bin/claude"
              value={claudePath}
              onChange={(e) => setClaudePath(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              onClick={() =>
                run('claude', async () => {
                  await api.setSetting('claude_path', claudePath)
                  setClaude(await api.claudeStatus())
                  setMsg({ kind: 'ok', text: 'claude 경로를 저장했습니다.' })
                })
              }
            >
              저장 후 확인
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>구글시트 연결 (매핑 기준표)</h3>

        <div className="field">
          <label>① 서비스 계정 키 파일 (.json)</label>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void pickKey(f)
            }}
          />
          {email && (
            <div className="row small" style={{ marginTop: 8 }}>
              <span className="mono">{email}</span>
              <button onClick={() => navigator.clipboard.writeText(email)}>이메일 복사</button>
              <span className="muted">← 이 주소로 시트를 편집자 공유</span>
              <span className="spacer" />
              <button
                className="danger"
                onClick={() =>
                  run('clear', async () => {
                    await api.clearServiceAccountKey()
                    setEmail(null)
                  })
                }
              >
                키 삭제
              </button>
            </div>
          )}
        </div>

        <div className="field">
          <label>② 마스터 시트 URL</label>
          <input
            className="mono"
            placeholder="https://docs.google.com/spreadsheets/d/…"
            value={sheetUrl}
            onChange={(e) => setSheetUrl(e.target.value)}
          />
        </div>

        <div className="row">
          <button
            disabled={!!busy}
            onClick={() =>
              run('test', async () => {
                await api.setSetting('sheet_url', sheetUrl)
                const info = await api.testSheetConnection()
                setMsg({
                  kind: 'ok',
                  text: `연결됨 — "${info.title}" · 탭: ${info.tabs.join(', ') || '(없음)'}`,
                })
              })
            }
          >
            {busy === 'test' ? '확인 중…' : '연결 테스트'}
          </button>

          <button
            disabled={!!busy || !email}
            onClick={() =>
              run('init', async () => {
                await api.setSetting('sheet_url', sheetUrl)
                await api.initMasterSheet(seedTabs())
                onMaster(await api.syncMaster())
                setMsg({ kind: 'ok', text: '마스터 시트를 초기 데이터로 채웠습니다.' })
              })
            }
            title="⚠ 네 탭을 기본 데이터로 덮어씁니다. 직접 추가한 벤더는 사라집니다."
            onClickCapture={(ev) => {
              if (!confirm('시트의 Vendors/Cards/Locations/COA 탭을 기본 데이터로 덮어씁니다.\n직접 추가하신 벤더는 사라집니다. 계속할까요?')) {
                ev.stopPropagation()
                ev.preventDefault()
              }
            }}
          >
            {busy === 'init' ? '작성 중…' : '시트 초기화 (덮어씀)'}
          </button>

          <button
            className="primary"
            disabled={!!busy}
            onClick={() =>
              run('sync', async () => {
                await api.setSetting('sheet_url', sheetUrl)
                const m = await api.syncMaster()
                onMaster(m)
                setMsg({
                  kind: 'ok',
                  text: `동기화 완료 — 벤더 ${m.vendors.length} / 카드 ${m.cards.length} / 지점 ${m.locations.length} / COA ${m.coa.length}`,
                })
              })
            }
          >
            {busy === 'sync' ? '동기화 중…' : '지금 동기화'}
          </button>

          <span className="spacer" />
          <span className="muted small">
            {master.syncedAt ? `마지막 동기화 ${master.syncedAt}` : '아직 동기화 안 됨'}
          </span>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted small">시트 내용이 지워졌다면</span>
          {(['Vendors', 'Cards', 'Locations', 'COA'] as const).map((tab) => (
            <button
              key={tab}
              disabled={!!busy}
              title={`마지막 동기화 시점의 로컬 캐시로 ${tab} 탭을 되살립니다. 시트에만 있는 행은 그대로 둡니다.`}
              onClick={() =>
                run('restore', async () => {
                  if (!confirm(`${tab} 탭을 로컬 캐시로 되살립니다. 시트에만 있는 행은 유지됩니다. 계속할까요?`))
                    return
                  const r = await api.restoreMasterTab(tab)
                  onMaster(await api.syncMaster())
                  setMsg({
                    kind: 'ok',
                    text:
                      `${tab} 탭을 ${r.restored}행으로 되살렸습니다` +
                      (r.kept ? ` (시트에만 있던 ${r.kept}행 유지).` : '.'),
                  })
                })
              }
            >
              {tab} 복구
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>벤더 추가</h3>
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          시트의 <code className="mono">Vendors</code> 탭에 한 줄 붙입니다. 여기 등록해 두면 다음
          추출부터 결제수단·카드·계정과목이 자동으로 채워집니다.
        </p>

        <div className="row" style={{ marginBottom: 8 }}>
          <input
            placeholder="거래처명 (인보이스에 찍힌 정식 표기)"
            value={nv.name}
            onChange={(e) => setNv({ ...nv, name: e.target.value })}
            style={{ flex: 2, minWidth: 200 }}
          />
          <input
            placeholder="다른 표기 (여러 개면 | 로 구분)"
            value={nv.aliases}
            onChange={(e) => setNv({ ...nv, aliases: e.target.value })}
            style={{ flex: 2, minWidth: 180 }}
          />
        </div>

        <div className="row">
          <select
            value={nv.payment}
            onChange={(e) => setNv({ ...nv, payment: e.target.value })}
            style={{ width: 120 }}
          >
            <option value="">결제수단 —</option>
            {['CARD', 'CHECK', 'ACH'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>

          <select
            value={nv.card}
            onChange={(e) => setNv({ ...nv, card: e.target.value })}
            style={{ width: 130 }}
            disabled={nv.payment !== 'CARD'}
            title={nv.payment === 'CARD' ? '' : '결제수단이 CARD 일 때만 씁니다'}
          >
            <option value="">기본 카드 —</option>
            {master.cards.map((c) => <option key={c.cardId} value={c.cardId}>{c.cardId}</option>)}
          </select>

          <select
            value={nv.coa}
            onChange={(e) => setNv({ ...nv, coa: e.target.value })}
            style={{ width: 200 }}
          >
            <option value="">기본 계정과목 —</option>
            {master.coa.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          <input
            placeholder="메모"
            value={nv.notes}
            onChange={(e) => setNv({ ...nv, notes: e.target.value })}
            style={{ flex: 1, minWidth: 120 }}
          />

          <button
            className="primary"
            disabled={!!busy || !nv.name.trim()}
            onClick={() =>
              run('vendor', async () => {
                const exists = master.vendors.some(
                  (v) => v.canonicalName.trim().toLowerCase() === nv.name.trim().toLowerCase(),
                )
                if (exists && !confirm(`'${nv.name}' 은(는) 이미 있습니다. 그래도 추가할까요?`)) return

                await api.appendVendor([
                  nv.name.trim(),
                  nv.aliases.trim(),
                  nv.payment,
                  nv.payment === 'CARD' ? nv.card : '',
                  nv.coa,
                  nv.notes.trim(),
                ])
                onMaster(await api.syncMaster())
                setNv({ name: '', aliases: '', payment: '', card: '', coa: '', notes: '' })
                setMsg({ kind: 'ok', text: `'${nv.name.trim()}' 을(를) 추가했습니다.` })
              })
            }
          >
            {busy === 'vendor' ? '추가 중…' : '추가'}
          </button>
        </div>

        <div className="row small muted" style={{ marginTop: 8 }}>
          현재 등록된 벤더 {master.vendors.length}개
        </div>
      </div>

      <div className="panel">
        <h3>저장 용량</h3>

        {stats && (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="badge">전체 {api.formatBytes(stats.totalBytes)}</span>
              <span className="badge">페이지 이미지 {api.formatBytes(stats.imagesBytes)}</span>
              <span className="badge">데이터베이스 {api.formatBytes(stats.dbBytes)}</span>
              <span className="badge">작업 폴더 {stats.jobDirs}개</span>
              <span className="spacer" />
              <button onClick={loadStats}>새로고침</button>
            </div>

            {stats.totalBytes > 0 && (
              <div className="bar" style={{ marginBottom: 10 }}>
                <div
                  className="seg images"
                  style={{ width: `${(stats.imagesBytes / stats.totalBytes) * 100}%` }}
                  title={`페이지 이미지 ${api.formatBytes(stats.imagesBytes)}`}
                />
                <div
                  className="seg db"
                  style={{ width: `${(stats.dbBytes / stats.totalBytes) * 100}%` }}
                  title={`데이터베이스 ${api.formatBytes(stats.dbBytes)}`}
                />
              </div>
            )}

            <p className="muted small" style={{ margin: '0 0 10px' }}>
              용량은 대부분 페이지 이미지입니다. 이미지를 비워도 <b>추출된 표와 장부는 그대로
              남습니다</b> — 원본 페이지 미리보기만 볼 수 없게 됩니다.
            </p>

            <div className="row">
              <button
                disabled={!!busy || stats.imagesBytes === 0}
                onClick={() =>
                  run('img', async () => {
                    if (!confirm('모든 작업의 페이지 이미지를 지웁니다. 추출 결과와 장부는 유지됩니다. 계속할까요?'))
                      return
                    const freed = await api.clearPageImages()
                    await loadStats()
                    setMsg({ kind: 'ok', text: `페이지 이미지를 비워 ${api.formatBytes(freed)} 확보했습니다.` })
                  })
                }
              >
                {busy === 'img' ? '정리 중…' : '페이지 이미지 모두 비우기'}
              </button>

              <span className="muted small" style={{ marginLeft: 8 }}>이력 정리</span>
              <select value={purgeDays} onChange={(ev) => setPurgeDays(ev.target.value)} style={{ width: 130 }}>
                <option value="30">30일 이전</option>
                <option value="90">90일 이전</option>
                <option value="180">180일 이전</option>
                <option value="365">1년 이전</option>
              </select>
              <button
                className="danger"
                disabled={!!busy}
                onClick={() =>
                  run('purge', async () => {
                    const days = Number(purgeDays)
                    const cutoff = new Date(Date.now() - days * 86400_000)
                    const iso = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')} 00:00:00`
                    if (!confirm(`${days}일 이전 추출 이력을 삭제합니다. 장부(확정 내역)는 삭제되지 않습니다. 계속할까요?`))
                      return
                    const res = await api.purgeJobsBefore(iso)
                    await loadStats()
                    setMsg({
                      kind: 'ok',
                      text: `이력 ${res.deleted}건을 삭제하고 ${api.formatBytes(res.freedBytes)} 확보했습니다.`,
                    })
                  })
                }
              >
                {busy === 'purge' ? '삭제 중…' : '오래된 이력 삭제'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="panel">
        <h3>데이터 저장 위치</h3>
        <div className="row">
          <code className="mono small" style={{ flex: 1, wordBreak: 'break-all' }}>{dir}</code>
          <button onClick={() => navigator.clipboard.writeText(dir)}>경로 복사</button>
        </div>
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          페이지 이미지·추출 이력·프롬프트·장부가 여기 저장됩니다. 서비스 계정 키는 이 폴더가
          아니라 OS 자격증명 저장소에 들어갑니다.
        </p>
      </div>
    </>
  )
}

/** 초기화 버튼이 시트에 써넣을 내용. */
function seedTabs(): Record<string, string[][]> {
  const m = MASTER_SEED
  return {
    Vendors: [
      [...SHEET_TABS.Vendors],
      ...m.vendors.map((v) => [
        v.canonicalName,
        v.aliases.join('|'),
        v.payment,
        v.defaultCardId,
        v.defaultCoa,
        v.notes,
      ]),
    ],
    Cards: [[...SHEET_TABS.Cards], ...m.cards.map((c) => [c.last4, c.cardId, c.notes])],
    Locations: [
      [...SHEET_TABS.Locations],
      ...m.locations.map((l) => [l.code, l.name, l.hints.join('|')]),
    ],
    COA: [[...SHEET_TABS.COA], ...m.coa.map((c) => [c])],
  }
}
