import { invoke } from '@tauri-apps/api/core'
import type { Master, Payment, VendorRule } from './types'

// ── claude ────────────────────────────────────────────────────────

export const claudeStatus = () => invoke<string>('claude_status')

export const stagePages = (jobId: string, pagesBase64: string[]) =>
  invoke<string>('stage_pages', { jobId, pagesBase64 })

export const runExtraction = (jobId: string, prompt: string, timeoutSecs = 900) =>
  invoke<{ result: unknown; elapsedMs: number }>('run_extraction', { jobId, prompt, timeoutSecs })

// ── jobs ──────────────────────────────────────────────────────────

export const createJob = (args: {
  pdfName: string
  pdfPath: string
  pageCount: number
  promptId: string | null
  promptSnapshot: string
}) => invoke<string>('create_job', args)

export const setJobStatus = (jobId: string, status: string, error?: string) =>
  invoke<void>('set_job_status', { jobId, status, error: error ?? null })

export const saveJobPayload = (jobId: string, payload: unknown) =>
  invoke<void>('save_job_payload', { jobId, payload })

export const listJobs = () => invoke<any[]>('list_jobs')
export const deleteJob = (jobId: string) => invoke<void>('delete_job', { jobId })

// ── prompts ───────────────────────────────────────────────────────

export const savePrompt = (args: {
  id: string | null
  name: string
  body: string
  builtin?: boolean
}) => invoke<string>('save_prompt', args)
export const listPrompts = () => invoke<any[]>('list_prompts')
export const deletePrompt = (id: string) => invoke<void>('delete_prompt', { id })

// ── settings ──────────────────────────────────────────────────────

export const getSetting = (key: string) => invoke<string | null>('get_setting', { key })
export const setSetting = (key: string, value: string) =>
  invoke<void>('set_setting', { key, value })
export const dataDir = () => invoke<string>('data_dir')

// ── 저장 용량 ──────────────────────────────────────────────────────

export interface StorageStats {
  dataDir: string
  dbBytes: number
  imagesBytes: number
  totalBytes: number
  jobDirs: number
  perJob: { id: string; bytes: number; images: number }[]
}

export const storageStats = () => invoke<StorageStats>('storage_stats')

/** jobId 를 주면 그 작업만, 없으면 전체. 확보한 바이트 수를 돌려준다. */
export const clearPageImages = (jobId?: string) =>
  invoke<number>('clear_page_images', { jobId: jobId ?? null })

export const purgeJobsBefore = (before: string) =>
  invoke<{ deleted: number; freedBytes: number }>('purge_jobs_before', { before })

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

// ── google sheets ─────────────────────────────────────────────────

export const saveServiceAccountKey = (keyJson: string) =>
  invoke<string>('save_service_account_key', { keyJson })
export const serviceAccountEmail = () => invoke<string | null>('service_account_email')
export const clearServiceAccountKey = () => invoke<void>('clear_service_account_key')

export const testSheetConnection = () =>
  invoke<{ title: string; tabs: string[]; clientEmail: string }>('test_sheet_connection')

export const syncMasterRaw = () => invoke<Record<string, any>>('sync_master')
export const cachedMasterRaw = () => invoke<Record<string, any>>('cached_master')
export const initMasterSheet = (tabs: Record<string, string[][]>) =>
  invoke<void>('init_master_sheet', { tabs })
export const appendVendor = (row: string[]) => invoke<void>('append_vendor', { row })

// 장부는 로컬이 1차 저장소다. 시트는 나중에 동기화한다.
export const saveRecordsLocal = (header: string[], rows: string[][]) =>
  invoke<{ saved: number; unchanged: number; pending: number }>('save_records_local', { header, rows })

export const listRecordsLocal = () =>
  invoke<{ rows: { key: string; values: string[]; synced: boolean }[]; pending: number }>(
    'list_records_local',
  )

export const deleteRecordLocal = (key: string) => invoke<void>('delete_record_local', { key })

export const syncRecords = (header: string[]) =>
  invoke<{ pushed: number; pulled: number; conflicts: number; syncedAt: string }>('sync_records', {
    header,
  })

export const readRecords = () => invoke<string[][]>('read_records')

// ── 시트 원본 → 앱 모델 ────────────────────────────────────────────

const splitList = (s: string) =>
  (s ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * 시트에서 받은 2차원 배열을 Master 로 바꾼다.
 * 사람이 직접 편집하는 시트라 헤더 순서가 바뀌어도 견디도록 헤더명으로 컬럼을 찾는다.
 */
export function parseMaster(raw: Record<string, any>): Master {
  const table = (tab: string): Record<string, string>[] => {
    const rows: string[][] = Array.isArray(raw[tab]) ? raw[tab] : []
    if (rows.length < 2) return []
    const header = rows[0].map((h) => h.trim().toLowerCase())
    return rows.slice(1)
      .filter((r) => r.some((c) => c && c.trim()))
      .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
  }

  const vendors: VendorRule[] = table('Vendors').map((r) => ({
    canonicalName: r['canonical_name'] ?? '',
    aliases: splitList(r['aliases']),
    payment: (r['payment'] as Payment) || '',
    defaultCardId: r['default_card_id'] ?? '',
    defaultCoa: r['default_coa'] ?? '',
    notes: r['notes'] ?? '',
  })).filter((v) => v.canonicalName)

  return {
    vendors,
    cards: table('Cards')
      .map((r) => ({ last4: r['last4'] ?? '', cardId: r['card_id'] ?? '', notes: r['notes'] ?? '' }))
      .filter((c) => c.last4),
    locations: table('Locations')
      .map((r) => ({ code: r['code'] ?? '', name: r['name'] ?? '', hints: splitList(r['hints']) }))
      .filter((l) => l.code),
    coa: table('COA').map((r) => r['coa']).filter(Boolean),
    syncedAt: typeof raw.syncedAt === 'string' && raw.syncedAt ? raw.syncedAt : null,
  }
}

export const syncMaster = async () => parseMaster(await syncMasterRaw())
export const cachedMaster = async () => parseMaster(await cachedMasterRaw())
