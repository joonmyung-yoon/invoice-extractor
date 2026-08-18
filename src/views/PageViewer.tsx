import { useEffect, useRef, useState } from 'react'
import * as api from '../lib/api'

interface Props {
  /** 볼 페이지 번호들 (1-based) */
  pages: number[]
  /** 추출 직후라면 화면이 들고 있는 미리보기. 없으면 디스크에서 읽는다. */
  previews?: string[]
  jobId?: string | null
  /** 표에서 고른 행을 설명하는 짧은 글 */
  caption?: string
}

/**
 * 원본 스캔 페이지를 크게 보여준다.
 *
 * 추출 결과가 맞는지 확인하려면 결국 종이를 봐야 한다. 표에서 행을 고르면
 * 그 행이 나온 페이지가 바로 옆에 뜨도록 만든 화면이다.
 */
export function PageViewer({ pages, previews, jobId, caption }: Props) {
  const [idx, setIdx] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [loaded, setLoaded] = useState<Record<number, string | null>>({})
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null)

  const page = pages[Math.min(idx, pages.length - 1)]

  // 페이지가 바뀌면 처음 위치로 돌려놓는다.
  useEffect(() => {
    setIdx(0)
  }, [pages.join(',')])

  useEffect(() => {
    setZoom(1)
    if (boxRef.current) {
      boxRef.current.scrollTop = 0
      boxRef.current.scrollLeft = 0
    }
  }, [page])

  // 미리보기가 있으면 그대로 쓰고, 없으면 디스크에서 읽어 온다.
  const src = previews?.[page - 1] ?? loaded[page] ?? null

  useEffect(() => {
    if (!page || src !== null || !jobId) return
    if (page in loaded) return
    setLoading(true)
    api
      .pageImage(jobId, page)
      .then((d) => setLoaded((m) => ({ ...m, [page]: d })))
      .catch(() => setLoaded((m) => ({ ...m, [page]: null })))
      .finally(() => setLoading(false))
  }, [page, jobId, src])

  if (!pages.length) {
    return (
      <div className="viewer empty">
        <div className="muted small">표에서 행을 고르면 그 행이 나온 원본 페이지가 여기 보입니다.</div>
      </div>
    )
  }

  const onWheel = (e: React.WheelEvent) => {
    // 확대는 트랙패드 핀치나 Cmd+휠 로만. 그냥 스크롤은 페이지를 훑는 데 쓴다.
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setZoom((z) => Math.min(6, Math.max(0.5, z - e.deltaY * 0.003)))
  }

  return (
    <div className="viewer">
      <div className="vhead">
        <button disabled={idx === 0} onClick={() => setIdx((i) => i - 1)} title="이전 페이지">
          ‹
        </button>
        <span className="badge">
          p.{page}
          {pages.length > 1 && ` (${idx + 1}/${pages.length})`}
        </span>
        <button
          disabled={idx >= pages.length - 1}
          onClick={() => setIdx((i) => i + 1)}
          title="다음 페이지"
        >
          ›
        </button>

        {caption && <span className="muted small vcap">{caption}</span>}

        <span className="spacer" />
        <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>−</button>
        <span className="mono small" style={{ minWidth: 38, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button onClick={() => setZoom((z) => Math.min(6, z + 0.25))}>+</button>
        <button onClick={() => setZoom(1)} title="맞춤">
          맞춤
        </button>
      </div>

      <div
        className="vbody"
        ref={boxRef}
        onWheel={onWheel}
        onMouseDown={(e) => {
          const b = boxRef.current
          if (!b) return
          drag.current = { x: e.clientX, y: e.clientY, l: b.scrollLeft, t: b.scrollTop }
        }}
        onMouseMove={(e) => {
          const d = drag.current
          const b = boxRef.current
          if (!d || !b) return
          b.scrollLeft = d.l - (e.clientX - d.x)
          b.scrollTop = d.t - (e.clientY - d.y)
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        style={{ cursor: zoom > 1 ? 'grab' : 'default' }}
      >
        {src ? (
          <img src={src} alt={`page ${page}`} style={{ width: `${zoom * 100}%` }} />
        ) : loading ? (
          <div className="muted small pad">불러오는 중…</div>
        ) : (
          <div className="muted small pad">
            이 페이지의 이미지가 없습니다.
            <br />
            설정에서 페이지 이미지를 비웠다면 원본은 볼 수 없습니다 (추출 결과는 그대로입니다).
          </div>
        )}
      </div>
    </div>
  )
}
