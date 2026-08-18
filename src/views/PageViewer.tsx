import { useEffect, useRef, useState } from 'react'
import * as api from '../lib/api'
import { renderPage } from '../lib/pdfCache'

export interface Highlight {
  field: string
  label: string
  page: number
  /** [x0, y0, x1, y1], 페이지 크기 대비 0~1000 */
  box: [number, number, number, number]
}

export interface ViewerTarget {
  jobId: string | null
  pages: number[]
  caption?: string
  /** 값을 읽어온 자리들. 테두리로만 표시한다. */
  highlights?: Highlight[]
  /** 지금 보고 있는 필드. 그 자리만 진하게 표시한다. */
  activeField?: string | null
}

interface Props extends ViewerTarget {
  /** 추출 직후라면 이미 만들어 둔 미리보기. PDF 가 없을 때의 대비책. */
  fallback?: string[]
  onClose?: () => void
  onPopOut?: () => void
  /** 새 창 모드에서는 머리글을 단순하게 만든다. */
  standalone?: boolean
}

/**
 * 원본 스캔 페이지를 보여준다.
 *
 * 표에서 고른 행이 어느 페이지에서 나왔는지 바로 확인하기 위한 화면이다.
 * 폭에 맞춰 자동으로 크기를 잡고, 확대하면 PDF 에서 더 선명하게 다시 그린다.
 */
export function PageViewer({
  jobId,
  pages,
  caption,
  fallback,
  highlights,
  activeField,
  onClose,
  onPopOut,
  standalone,
}: Props) {
  const [idx, setIdx] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [src, setSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // 영역 표시가 글자를 가리면 오히려 방해가 되므로 끌 수 있게 한다.
  const [showBoxes, setShowBoxes] = useState(
    () => localStorage.getItem('showBoxes') !== 'off',
  )
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null)

  const page = pages[Math.min(idx, Math.max(0, pages.length - 1))]

  useEffect(() => setIdx(0), [pages.join(',')])

  // 고른 칸이 다른 페이지에서 나온 값이면 그 페이지를 보여준다.
  useEffect(() => {
    if (!activeField || !highlights) return
    const h = highlights.find((x) => x.field === activeField)
    if (!h) return
    const at = pages.indexOf(h.page)
    if (at >= 0) setIdx(at)
  }, [activeField, highlights, pages.join(',')])

  useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = 0
      boxRef.current.scrollLeft = 0
    }
  }, [page])

  // 표시 폭보다 크게 그려야 확대해도 뭉개지지 않는다.
  useEffect(() => {
    let alive = true
    if (!page || !jobId) {
      setSrc(null)
      return
    }
    const box = boxRef.current?.clientWidth ?? 900
    setLoading(true)
    // PDF 가 있으면 원하는 배율로 다시 그려 가장 선명하다.
    renderPage(jobId, page, Math.round(box * zoom * 1.5))
      .then(async (url) => {
        if (url) return url
        // PDF 를 보관하기 전에 만든 기록이면 추출 때 쓴 페이지 이미지로 대신한다.
        if (fallback?.[page - 1]) return fallback[page - 1]
        return await api.pageImage(jobId, page).catch(() => null)
      })
      .then((url) => alive && setSrc(url))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [page, jobId, zoom, fallback])

  if (!pages.length) {
    return (
      <div className="viewer empty">
        <div className="muted small">표에서 행을 고르면 그 행이 나온 원본이 여기 보입니다.</div>
      </div>
    )
  }

  return (
    <div className="viewer">
      <div className="vhead">
        <button disabled={idx === 0} onClick={() => setIdx((i) => i - 1)} title="이전 페이지">
          ‹
        </button>
        <span className="badge">
          p.{page}
          {pages.length > 1 && ` · ${idx + 1}/${pages.length}`}
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
        <button onClick={() => setZoom((z) => Math.max(0.4, z - 0.25))} title="축소">−</button>
        <button onClick={() => setZoom(1)} className="mono small" title="폭 맞춤">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => setZoom((z) => Math.min(5, z + 0.25))} title="확대">+</button>

        {highlights && highlights.length > 0 && (
          <button
            className={showBoxes ? 'on' : ''}
            onClick={() => {
              const next = !showBoxes
              setShowBoxes(next)
              localStorage.setItem('showBoxes', next ? 'on' : 'off')
            }}
            title="값을 읽어온 자리를 원본에 테두리로 표시합니다"
          >
            영역
          </button>
        )}
        {onPopOut && (
          <button onClick={onPopOut} title="새 창으로 열기 (다른 화면에 놓고 볼 수 있습니다)">
            ⧉
          </button>
        )}
        {onClose && !standalone && (
          <button onClick={onClose} title="닫기">
            ✕
          </button>
        )}
      </div>

      <div
        className="vbody"
        ref={boxRef}
        onDoubleClick={() => setZoom((z) => (z > 1 ? 1 : 2))}
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
          <div className="vstage" style={{ width: `${zoom * 100}%` }}>
            <img src={src} alt={`page ${page}`} />
            {showBoxes &&
              highlights
                ?.filter((h) => h.page === page)
                .map((h) => (
                  <span
                    key={h.field}
                    className={`hl ${activeField === h.field ? 'on' : ''}`}
                    style={{
                      left: `${h.box[0] / 10}%`,
                      top: `${h.box[1] / 10}%`,
                      width: `${(h.box[2] - h.box[0]) / 10}%`,
                      height: `${(h.box[3] - h.box[1]) / 10}%`,
                    }}
                    title={h.label}
                  >
                    <i>{h.label}</i>
                  </span>
                ))}
          </div>
        ) : loading ? (
          <div className="muted small pad">불러오는 중…</div>
        ) : (
          <div className="muted small pad">
            원본을 찾을 수 없습니다.
            <br />
            설정에서 페이지 이미지를 비웠다면 원본은 볼 수 없습니다 (추출 결과는 그대로입니다).
          </div>
        )}
      </div>
    </div>
  )
}
