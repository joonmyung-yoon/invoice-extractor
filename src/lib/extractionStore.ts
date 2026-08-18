import { useSyncExternalStore } from 'react'
import type { Invoice, Row } from './types'

/**
 * 진행 중인 추출 상태를 화면 바깥에 둔다.
 *
 * 화면 컴포넌트 안에 두면 탭을 옮기는 순간 언마운트되면서 상태가 날아가고, 백엔드에서는
 * 추출이 계속 돌고 있는데 화면에는 아무것도 안 남는 일이 생긴다. 앱이 떠 있는 동안은
 * 어느 탭에 있든 진행 상황이 유지되어야 한다.
 */
export type Stage = 'idle' | 'rendering' | 'extracting' | 'done' | 'error'

export interface ExtractionState {
  stage: Stage
  jobId: string | null
  pdfName: string
  progress: { done: number; total: number }
  startedAt: number | null
  elapsed: number
  error: string | null
  /** claude 가 지금까지 확인한 페이지 수 (추출 단계) */
  pagesRead: number
  /** 현재 무엇을 하고 있는지 */
  phase: string
  rows: Row[]
  invoices: Invoice[]
  previews: string[]
  unknownVendors: { name: string; pages: number[]; suggestedCoa: string }[]
  coverage: { missing: number[]; duplicated: number[] } | null
}

const INITIAL: ExtractionState = {
  stage: 'idle',
  jobId: null,
  pdfName: '',
  progress: { done: 0, total: 0 },
  startedAt: null,
  elapsed: 0,
  error: null,
  pagesRead: 0,
  phase: '',
  rows: [],
  invoices: [],
  previews: [],
  unknownVendors: [],
  coverage: null,
}

let state: ExtractionState = INITIAL
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export const extraction = {
  get: () => state,

  set(patch: Partial<ExtractionState>) {
    state = { ...state, ...patch }
    emit()
  },

  reset() {
    // 미리보기 blob 은 명시적으로 놓아주지 않으면 앱이 꺼질 때까지 메모리에 남는다.
    state.previews.forEach(URL.revokeObjectURL)
    state = INITIAL
    emit()
  },

  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },

  /** 추출이 진행 중이면 true. 다른 탭에서 배지를 띄우는 데 쓴다. */
  isBusy: () => state.stage === 'rendering' || state.stage === 'extracting',
}

export function useExtraction(): ExtractionState {
  return useSyncExternalStore(extraction.subscribe, extraction.get)
}

/** 초를 "1분 20초" 처럼 읽기 쉽게 만든다. */
export function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}초`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}분 ${s}초` : `${m}분`
}
