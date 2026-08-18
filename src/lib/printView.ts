import { OUTPUT_COLUMNS, COLUMN_LABELS, type Row } from './types'
import { toSheetRows } from './export'

/**
 * 표를 PDF 로 내보낸다.
 *
 * PDF 를 직접 만들지 않고 웹뷰의 인쇄 기능을 쓴다. 직접 만들려면 한글 글꼴을 파일에
 * 심어야 하는데(용량도 크고 깨지기 쉽다), 인쇄 경로는 화면에 이미 보이는 그대로를
 * 넘기므로 한글·정렬이 그대로 유지된다. macOS 는 'PDF 로 저장', 윈도우는
 * 'Microsoft Print to PDF' 로 저장하면 된다.
 */
export function printRows(rows: Row[], title: string) {
  const labels = OUTPUT_COLUMNS.map((c) => COLUMN_LABELS[c] ?? c)
  const data = toSheetRows(rows)
  const total = rows.reduce((a, r) => a + r.amount, 0)

  const esc = (v: string) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

  // 금액은 오른쪽 정렬해야 읽힌다. FileName 은 길어서 줄바꿈을 허용한다.
  const iAmt = OUTPUT_COLUMNS.indexOf('AMT')
  const iFile = OUTPUT_COLUMNS.length - 1

  const head = labels.map((l) => `<th>${esc(l)}</th>`).join('')
  const body = data
    .map(
      (r) =>
        '<tr>' +
        r
          .map((v, i) => {
            const cls = i === iAmt ? ' class="num"' : i === iFile ? ' class="wrap"' : ''
            return `<td${cls}>${esc(v)}</td>`
          })
          .join('') +
        '</tr>',
    )
    .join('')

  const host = document.createElement('div')
  host.id = 'print-root'
  host.innerHTML = `
    <div class="ph">
      <h1>${esc(title)}</h1>
      <div class="meta">
        ${rows.length}행 · 합계 ${total.toFixed(2)} ·
        ${new Date().toLocaleString('ko-KR')}
      </div>
    </div>
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  `
  document.body.appendChild(host)

  const cleanup = () => {
    host.remove()
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)

  window.print()

  // afterprint 를 주지 않는 환경이 있어 대비한다.
  setTimeout(cleanup, 60_000)
}
