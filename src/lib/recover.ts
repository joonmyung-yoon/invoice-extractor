import * as api from './api'
import { mergeResults } from './chunking'
import { normalize } from './normalize'
import type { Master } from './types'

/**
 * 끝나지 못한 작업의 결과를 디스크에서 주워 담는다.
 *
 * 앱을 강제 종료하면 claude 프로세스는 살아남아 결과를 끝까지 쓴다. 그런데 받아 갈
 * 앱이 없어서 그대로 버려진다. 이미 비용을 치른 작업이라 다시 켰을 때 되살린다.
 * 정상 종료로 중간에 끊긴 경우에도 먼저 끝난 조각은 살릴 수 있다.
 */
export async function recoverUnfinished(master: Master): Promise<
  { pdfName: string; rows: number }[]
> {
  const recovered: { pdfName: string; rows: number }[] = []

  for (const job of await api.unfinishedJobs().catch(() => [])) {
    const parts = await api.chunkResults(job.id).catch(() => [])
    if (!parts.length) continue

    const merged = mergeResults(parts)
    const norm = normalize(merged, master)
    if (!norm.rows.length) continue

    await api.saveJobPayload(job.id, {
      raw: merged,
      rows: norm.rows,
      invoices: norm.invoices,
    })
    recovered.push({ pdfName: job.pdfName, rows: norm.rows.length })
  }

  return recovered
}
