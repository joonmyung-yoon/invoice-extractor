import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Claude 는 이미지를 긴 변 1568px 기준으로 줄여서 본다. 그보다 크게 렌더링하면
 * 디스크·전송량만 늘고 인식률은 그대로라, 긴 변을 이 값에 맞춘다.
 */
const TARGET_LONG_EDGE = 1568

export interface RenderedPage {
  pageNumber: number
  /** base64 (헤더 없음) */
  data: string
  /** 미리보기용 blob URL */
  previewUrl: string
  width: number
  height: number
}

export interface LoadedPdf {
  pageCount: number
  render: (pageNumber: number, rotation?: number) => Promise<RenderedPage>
  destroy: () => void
}

export async function loadPdf(bytes: ArrayBuffer): Promise<LoadedPdf> {
  // pdf.js 가 버퍼를 detach 시키므로 사본을 넘긴다 (같은 파일 재처리 대비).
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise

  return {
    pageCount: doc.numPages,
    destroy: () => void doc.destroy(),
    async render(pageNumber, rotation = 0) {
      const page = await doc.getPage(pageNumber)
      const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 })
      const scale = TARGET_LONG_EDGE / Math.max(base.width, base.height)
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 })

      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('캔버스를 만들지 못했습니다.')

      // 스캔본은 배경이 흰색이라 먼저 흰색으로 채워야 얼룩이 생기지 않는다.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise

      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('페이지 이미지를 만들지 못했습니다.'))),
          'image/png',
        ),
      )
      const buf = await blob.arrayBuffer()

      page.cleanup()
      return {
        pageNumber,
        data: toBase64(new Uint8Array(buf)),
        previewUrl: URL.createObjectURL(blob),
        width: canvas.width,
        height: canvas.height,
      }
    },
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000 // 큰 배열을 한 번에 넘기면 스택이 터진다.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
