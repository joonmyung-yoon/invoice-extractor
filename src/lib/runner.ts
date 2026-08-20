import * as api from './api'
import { loadPdf } from './pdf'
import { buildPrompt } from './defaultPrompt'
import { checkPageCoverage, normalize } from './normalize'
import { mergeResults, planChunks } from './chunking'
import { extraction, type Job } from './extractionStore'
import type { Master, Prompt } from './types'

/** PDF 한 건을 조각으로 나눠 동시에 추출하고, 결과를 합쳐 저장한다. */

export async function runJob(job: Job, master: Master, prompt: Prompt, maxChunks: number) {
  const id = job.id
  const p = (x: Partial<Job>) => extraction.patch(id, x)

  try {
    p({ stage: 'rendering', startedAt: Date.now(), phase: '' })
    const bytes = await job.file!.arrayBuffer()
    const pdf = await loadPdf(bytes)
    p({ pageCount: pdf.pageCount })

    const body = buildPrompt(prompt.body, master)
    const jobId = await api.createJob({
      pdfName: job.fileName,
      pdfPath: job.fileName,
      pageCount: pdf.pageCount,
      promptId: prompt.id,
      promptSnapshot: body,
    })
    p({ jobId })
    await api.storePdf(jobId, new Uint8Array(bytes)).catch((err) =>
        // 보관에 실패해도 추출은 계속한다. 원본 대조만 불가능해진다.
        console.warn('원본 PDF 보관 실패:', err),
      )

    // 페이지를 한 번만 그려 두고 조각마다 나눠 쓴다.
    const images: string[] = []
    const urls: string[] = []
    for (let n = 1; n <= pdf.pageCount; n++) {
      const img = await pdf.render(n)
      images.push(img.data)
      urls.push(img.previewUrl)
      p({ rendered: n, previews: [...urls] })
    }
    pdf.destroy()

    const chunks = planChunks(pdf.pageCount, maxChunks)
    for (const [i, pages] of chunks.entries()) {
      await api.stagePages(jobId, i, pages, pages.map((n) => images[n - 1]))
    }

    p({ stage: 'extracting', phase: chunks.length > 1 ? `${chunks.length}조각 동시 처리` : '' })
    await api.setJobStatus(jobId, 'extracting')

    // 조각별로 읽은 페이지 수를 합쳐 전체 진행률로 보여준다.
    const readPerChunk = new Array(chunks.length).fill(0)
    const off = api.onExtractionProgress((ev) => {
      const [evJob, evChunk] = ev.jobId.split('#')
      if (evJob !== jobId) return
      readPerChunk[Number(evChunk) || 0] = ev.pagesRead
      const total = readPerChunk.reduce((a, b) => a + b, 0)
      p({ pagesRead: Math.min(total, pdf.pageCount), phase: ev.phase })
    })

    try {
      const parts = await Promise.all(
        chunks.map((_, i) => api.runExtraction(jobId, i, body).then((r) => r.result)),
      )
      const merged = mergeResults(parts)

      const norm = normalize(merged, master)
      const cov = checkPageCoverage(norm.invoices, pdf.pageCount)
      await api.saveJobPayload(jobId, {
        raw: merged,
        rows: norm.rows,
        invoices: norm.invoices,
      })

      p({
        stage: 'done',
        finishedAt: Date.now(),
        raw: merged,
        rows: norm.rows,
        invoices: norm.invoices,
        unknownVendors: norm.unknownVendors,
        coverage: cov.ok ? null : { missing: cov.missing, duplicated: cov.duplicated },
        phase: '',
      })
    } finally {
      void off.then((f) => f())
    }
  } catch (err) {
    p({ stage: 'error', error: String(err), finishedAt: Date.now() })
    const jid = extraction.get().jobs.find((j) => j.id === id)?.jobId
    if (jid) await api.setJobStatus(jid, 'error', String(err)).catch(() => {})
  }
}
