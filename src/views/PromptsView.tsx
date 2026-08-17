import { useEffect, useState } from 'react'
import * as api from '../lib/api'
import { DEFAULT_PROMPT, renderMaster } from '../lib/defaultPrompt'
import type { Master, Prompt } from '../lib/types'

interface Props {
  master: Master
  activeId: string | null
  onActive: (id: string) => void
}

export function PromptsView({ master, activeId, onActive }: Props) {
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [sel, setSel] = useState<Prompt | null>(null)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState(false)

  const reload = async () => {
    const list = (await api.listPrompts()) as Prompt[]
    setPrompts(list)
    return list
  }

  useEffect(() => {
    void reload().then((list) => {
      const first = list.find((p) => p.id === activeId) ?? list[0]
      if (first) pick(first)
    })
  }, [])

  const pick = (p: Prompt) => {
    setSel(p)
    setName(p.name)
    setBody(p.body)
  }

  const dirty = sel ? sel.name !== name || sel.body !== body : false

  return (
    <>
      <h2>프롬프트</h2>
      <p className="sub">
        추출 지시문입니다. <code className="mono">{'{{MASTER}}'}</code> 자리에 구글시트의 매핑
        기준표가 자동으로 채워집니다.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14 }}>
        <div>
          {prompts.map((p) => (
            <div key={p.id} className={`list-item ${sel?.id === p.id ? 'active' : ''}`}>
              <button
                className="nav-item"
                style={{ flex: 1, padding: 0 }}
                onClick={() => pick(p)}
              >
                <div style={{ color: 'var(--text)' }}>{p.name}</div>
                <div className="small muted">
                  {p.builtin ? '기본 제공' : p.createdAt}
                  {activeId === p.id ? ' · 사용 중' : ''}
                </div>
              </button>
            </div>
          ))}

          <button
            style={{ width: '100%', marginTop: 6 }}
            onClick={async () => {
              const id = await api.savePrompt({
                id: null,
                name: `사본 ${new Date().toLocaleDateString('ko-KR')}`,
                body: body || DEFAULT_PROMPT,
              })
              const list = await reload()
              const made = list.find((p) => p.id === id)
              if (made) pick(made)
            }}
          >
            + 현재 내용으로 새 프롬프트
          </button>
        </div>

        <div className="panel" style={{ margin: 0 }}>
          <div className="field">
            <label>이름</label>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={sel?.builtin} />
          </div>

          <div className="field">
            <label>
              내용{' '}
              <button
                className="small"
                style={{ padding: '1px 8px', marginLeft: 6 }}
                onClick={() => setPreview((v) => !v)}
              >
                {preview ? '편집으로' : '마스터 적용 미리보기'}
              </button>
            </label>
            {preview ? (
              <textarea
                readOnly
                rows={26}
                value={body.replace('{{MASTER}}', renderMaster(master))}
              />
            ) : (
              <textarea
                rows={26}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={sel?.builtin}
              />
            )}
          </div>

          <div className="row">
            <button
              className="primary"
              disabled={!sel || sel.builtin || !dirty}
              onClick={async () => {
                if (!sel) return
                await api.savePrompt({ id: sel.id, name, body })
                const list = await reload()
                const saved = list.find((p) => p.id === sel.id)
                if (saved) pick(saved)
              }}
            >
              저장
            </button>
            <button disabled={!sel || activeId === sel.id} onClick={() => sel && onActive(sel.id)}>
              이 프롬프트 사용
            </button>
            <span className="spacer" />
            {sel?.builtin && <span className="muted small">기본 제공 프롬프트는 수정할 수 없습니다. 새로 만들어 쓰세요.</span>}
            {sel && !sel.builtin && (
              <button
                className="danger"
                onClick={async () => {
                  await api.deletePrompt(sel.id)
                  const list = await reload()
                  if (list[0]) pick(list[0])
                }}
              >
                삭제
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
