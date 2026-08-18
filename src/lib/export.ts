import { BUYER_ENTITY, OUTPUT_COLUMNS, type Row } from './types'

/**
 * 장부에 붙여넣을 한 행을 만든다.
 *
 * Memo 는 우리 내부 메모라 장부 형식에 아예 없다 — 내보내지 않는다.
 */
function cells(row: Row): (string | number)[] {
  const pages = row.sourcePages.length ? row.sourcePages : []
  return [
    row.location,          // buyer — 지점 코드
    row.date,
    row.invoiceNumber,
    BUYER_ENTITY,          // vendor — 법인명(고정)
    row.vendorName,        // sub-vendor — 실제 거래처
    row.coa,
    row.amount,
    pages.length ? Math.min(...pages) : '',   // pageno — 시작 페이지
    pages.length || '',                        // pages — 걸친 장수
    row.payment,
    row.cardId,
  ]
}

/** Records 탭에 쌓을 문자열 행. 헤더는 OUTPUT_COLUMNS 와 같다. */
export function toSheetRows(rows: Row[]): string[][] {
  return rows.map((r) => cells(r).map(String))
}

/** 구글시트·엑셀에 그대로 붙여넣을 수 있는 TSV. */
export function toTsv(rows: Row[], withHeader = true): string {
  const lines = rows.map((r) => cells(r).join('\t'))
  return (withHeader ? [OUTPUT_COLUMNS.join('\t'), ...lines] : lines).join('\n')
}

/** 사람이 눈으로 확인하기 좋은 정렬된 텍스트. */
export function toText(rows: Row[]): string {
  const table = [OUTPUT_COLUMNS as readonly string[], ...rows.map((r) => cells(r).map(String))]
  const widths = table[0].map((_, c) => Math.max(...table.map((r) => [...String(r[c] ?? '')].length)))
  return table
    .map((r) => r.map((v, c) => String(v ?? '').padEnd(widths[c])).join('  ').trimEnd())
    .join('\n')
}

// ── xlsx ──────────────────────────────────────────────────────────

const DATE_COL = OUTPUT_COLUMNS.indexOf('date')
const AMT_COL = OUTPUT_COLUMNS.indexOf('amt')

/** Excel 날짜 일련번호. 1900 윤년 버그 때문에 기준일이 1899-12-30 이다. */
function excelSerial(mmddyyyy: string): number | null {
  const m = mmddyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  const [, mm, dd, yyyy] = m
  const utc = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86_400_000)
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const colName = (i: number) => {
  let s = ''
  for (let n = i + 1; n > 0; ) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/**
 * 실제 .xlsx 파일을 만든다.
 *
 * DATE 는 문자열이 아니라 진짜 날짜값 + mm/dd/yyyy 서식으로 넣는다. 샘플 파일이 겪은
 * "월/일이 뒤바뀌어 저장되는" 문제를 원천적으로 피하려면 이렇게 써야 한다.
 */
export function toXlsx(rows: Row[]): Uint8Array {
  const header = OUTPUT_COLUMNS.map(
    (h, c) => `<c r="${colName(c)}1" s="1" t="inlineStr"><is><t>${esc(h)}</t></is></c>`,
  ).join('')

  const body = rows
    .map((row, i) => {
      const r = i + 2
      const xml = cells(row)
        .map((v, c) => {
          const ref = `${colName(c)}${r}`
          if (c === DATE_COL) {
            const serial = excelSerial(String(v))
            return serial === null
              ? `<c r="${ref}" t="inlineStr"><is><t>${esc(String(v))}</t></is></c>`
              : `<c r="${ref}" s="2"><v>${serial}</v></c>` // s=2 → mm/dd/yyyy
          }
          if (typeof v === 'number') return `<c r="${ref}" s="${c === AMT_COL ? 3 : 0}"><v>${v}</v></c>`
          return v === '' ? `<c r="${ref}"/>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(String(v))}</t></is></c>`
        })
        .join('')
      return `<row r="${r}">${xml}</row>`
    })
    .join('')

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${header}</row>${body}</sheetData></worksheet>`

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs></styleSheet>`

  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Invoices" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', sheet],
  ])
}

// ── 최소 ZIP 작성기 (무압축 store) ─────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zip(entries: [string, string][]): Uint8Array {
  const enc = new TextEncoder()
  const files = entries.map(([name, content]) => ({
    name: enc.encode(name),
    data: enc.encode(content),
  }))

  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const f of files) {
    const crc = crc32(f.data)
    const local = new Uint8Array(30 + f.name.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    dv.setUint16(8, 0, true) // store
    dv.setUint32(14, crc, true)
    dv.setUint32(18, f.data.length, true)
    dv.setUint32(22, f.data.length, true)
    dv.setUint16(26, f.name.length, true)
    local.set(f.name, 30)

    const cd = new Uint8Array(46 + f.name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, f.data.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, f.name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(f.name, 46)

    chunks.push(local, f.data)
    central.push(cd)
    offset += local.length + f.data.length
  }

  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + centralSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const c of [...chunks, ...central, end]) {
    out.set(c, p)
    p += c.length
  }
  return out
}
