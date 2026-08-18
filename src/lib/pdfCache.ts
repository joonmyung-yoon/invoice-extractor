import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import * as api from './api'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * 원본 대조용 페이지 렌더러.
 *
 * 추출에 쓰는 이미지는 긴 변 1568px 로 줄여 만든다(claude 가 그 크기로 보기 때문).
 * 사람이 크게 볼 때는 그 해상도로 부족하므로, 보관해 둔 PDF 에서 필요한 배율로
 * 그때그때 다시 그린다.
 */

const docs = new Map<string, Promise<pdfjs.PDFDocumentProxy | null>>()
const pages = new Map<string, string>()

function loadDoc(jobId: string) {
  let d = docs.get(jobId)
  if (!d) {
    d = api
      .readPdf(jobId)
      .then((bytes) =>
        bytes ? pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise : null,
      )
      .catch(() => null)
    docs.set(jobId, d)
  }
  return d
}

/**
 * 페이지를 그려 data URL 로 돌려준다. PDF 가 없으면(예전 기록) null.
 * `targetWidth` 는 화면에 표시할 폭(px). 그보다 조금 크게 그려 선명하게 만든다.
 */
export async function renderPage(
  jobId: string,
  pageNumber: number,
  targetWidth: number,
): Promise<string | null> {
  // 배율을 잘게 나누면 캐시가 무한정 늘어난다. 단계로 끊어 재사용한다.
  const step = Math.min(4000, Math.max(900, Math.ceil(targetWidth / 400) * 400))
  const key = `${jobId}:${pageNumber}:${step}`
  const hit = pages.get(key)
  if (hit) return hit

  const doc = await loadDoc(jobId)
  if (!doc || pageNumber < 1 || pageNumber > doc.numPages) return null

  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1, rotation: page.rotate })
  const viewport = page.getViewport({ scale: step / base.width, rotation: page.rotate })

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise
  page.cleanup()

  const url = canvas.toDataURL('image/jpeg', 0.85)
  // 메모리가 무한정 늘지 않게 오래된 것부터 버린다.
  if (pages.size > 24) pages.delete(pages.keys().next().value!)
  pages.set(key, url)
  return url
}

export async function pageCount(jobId: string): Promise<number> {
  const doc = await loadDoc(jobId)
  return doc?.numPages ?? 0
}
