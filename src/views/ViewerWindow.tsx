import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { PageViewer, type ViewerTarget } from './PageViewer'

/**
 * 원본 대조 전용 창.
 *
 * 표와 원본이 좁은 화면을 나눠 쓰면 둘 다 불편하다. 이 창을 따로 띄우면
 * 다른 모니터에 놓거나 화면 절반을 통째로 원본에 줄 수 있다.
 * 본 창에서 행을 고를 때마다 이벤트로 알려 준다.
 */
export function ViewerWindow() {
  const [target, setTarget] = useState<ViewerTarget>({ jobId: null, pages: [] })

  useEffect(() => {
    const un = listen<ViewerTarget>('viewer-target', (e) => setTarget(e.payload))
    return () => void un.then((f) => f())
  }, [])

  return (
    <div className="viewer-window">
      {target.pages.length ? (
        <PageViewer {...target} standalone />
      ) : (
        <div className="viewer empty">
          <div className="muted small">
            본 창의 표에서 행을 고르면 그 원본이 여기 표시됩니다.
          </div>
        </div>
      )}
    </div>
  )
}
