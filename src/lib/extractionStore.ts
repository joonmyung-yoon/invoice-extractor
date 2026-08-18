import { useSyncExternalStore } from 'react'
import type { Invoice, Row } from './types'

/**
 * 진행 중·완료된 추출 작업들을 화면 바깥에서 관리한다.
 *
 * 화면 컴포넌트 안에 두면 탭을 옮기는 순간 상태가 날아간다. 또 한 번에 하나만
 * 처리하면 19페이지짜리 하나에 3~4분씩 묶여 있어야 하므로, 여러 건을 큐에 넣고
 * 정해진 개수만큼 동시에 돌린다.
 */
export type Stage = 'queued' | 'rendering' | 'extracting' | 'done' | 'error' | 'canceled'

export interface Job {
  id: string
  /** 백엔드 작업 id. 큐에 있는 동안에는 아직 없다. */
  jobId: string | null
  fileName: string
  file: File | null
  stage: Stage
  pageCount: number
  /** 페이지 변환 진행 */
  rendered: number
  /** claude 가 읽은 페이지 수 */
  pagesRead: number
  phase: string
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  raw: unknown
  rows: Row[]
  invoices: Invoice[]
  previews: string[]
  unknownVendors: { name: string; pages: number[]; suggestedCoa: string }[]
  coverage: { missing: number[]; duplicated: number[] } | null
}

interface State {
  jobs: Job[]
  /** 표를 보여줄 작업 */
  selectedId: string | null
  /** 동시에 몇 건까지 돌릴지 */
  concurrency: number
}

const STORED = Number(localStorage.getItem('concurrency'))
let state: State = {
  jobs: [],
  selectedId: null,
  concurrency: STORED >= 1 && STORED <= 4 ? STORED : 2,
}

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

let seq = 0

function patch(id: string, p: Partial<Job>) {
  state = { ...state, jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) }
  emit()
}

export const extraction = {
  get: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },

  /** 파일들을 큐에 넣는다. */
  enqueue(files: File[]) {
    const added: Job[] = files.map((f) => ({
      id: `q${++seq}`,
      jobId: null,
      fileName: f.name,
      file: f,
      stage: 'queued',
      pageCount: 0,
      rendered: 0,
      pagesRead: 0,
      phase: '',
      startedAt: null,
      finishedAt: null,
      error: null,
      raw: null,
      rows: [],
      invoices: [],
      previews: [],
      unknownVendors: [],
      coverage: null,
    }))
    state = {
      ...state,
      jobs: [...state.jobs, ...added],
      selectedId: state.selectedId ?? added[0]?.id ?? null,
    }
    emit()
    return added
  },

  patch,
  select(id: string | null) {
    state = { ...state, selectedId: id }
    emit()
  },

  setConcurrency(n: number) {
    localStorage.setItem('concurrency', String(n))
    state = { ...state, concurrency: n }
    emit()
  },

  /** 끝난 작업을 목록에서 치운다. 저장된 이력은 그대로 남는다. */
  remove(id: string) {
    const job = state.jobs.find((j) => j.id === id)
    job?.previews.forEach(URL.revokeObjectURL)
    const rest = state.jobs.filter((j) => j.id !== id)
    state = {
      ...state,
      jobs: rest,
      selectedId: state.selectedId === id ? (rest[0]?.id ?? null) : state.selectedId,
    }
    emit()
  },

  clearFinished() {
    for (const j of state.jobs) {
      if (j.stage === 'done' || j.stage === 'error' || j.stage === 'canceled') {
        j.previews.forEach(URL.revokeObjectURL)
      }
    }
    const rest = state.jobs.filter((j) => j.stage !== 'done' && j.stage !== 'error' && j.stage !== 'canceled')
    state = { ...state, jobs: rest, selectedId: rest[0]?.id ?? null }
    emit()
  },

  /** 지금 돌고 있는 건수. */
  activeCount: () =>
    state.jobs.filter((j) => j.stage === 'rendering' || j.stage === 'extracting').length,

  /** 다음에 시작할 대기 작업. */
  nextQueued: () => state.jobs.find((j) => j.stage === 'queued') ?? null,
}

export function useExtraction(): State {
  return useSyncExternalStore(extraction.subscribe, extraction.get)
}

/** 초를 "1분 20초" 처럼 읽기 쉽게 만든다. */
export function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}초`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}분 ${s}초` : `${m}분`
}
