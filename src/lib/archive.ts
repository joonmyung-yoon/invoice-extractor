import * as api from './api'
import { OUTPUT_COLUMNS } from './types'
import { toSheetRows } from './export'
import type { Row } from './types'

/**
 * 작업 기록을 구글시트 `History` 탭에 보관한다.
 *
 * 장부가 아니라 우리 작업 기록이다. 장부에 붙여넣는 11컬럼에 더해, 붙여넣을 때는
 * 빼는 내부 정보(메모·원본 PDF·추출 일시)까지 남긴다. 탭이 분리되어 있으므로
 * 장부용 복사에 섞일 일이 없다.
 *
 * PC 가 바뀌거나 여러 명이 써도 과거 기록이 유지되게 하는 것이 목적이다.
 */
export const ARCHIVE_COLUMNS = [...OUTPUT_COLUMNS, 'memo', 'pdf', 'saved_at'] as const

export function toArchiveRows(rows: Row[], pdfName: string): string[][] {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  return toSheetRows(rows).map((cells, i) => [...cells, rows[i].memo ?? '', pdfName, stamp])
}

export const saveToArchive = (rows: Row[], pdfName: string) =>
  api.saveRecordsLocal([...ARCHIVE_COLUMNS], toArchiveRows(rows, pdfName))

export const syncArchive = () => api.syncRecords([...ARCHIVE_COLUMNS])

export const listArchive = () => api.listRecordsLocal()

export const rewriteArchive = () => api.rewriteArchive([...ARCHIVE_COLUMNS])
