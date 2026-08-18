import type { FieldBox, Invoice, Master, Payment, Row } from './types'

/** 표기 흔들림(대소문자·구두점·공백)을 없앤 비교용 키. */
const key = (s: string) => s.toLowerCase().replace(/[.,'"()\-\s]+/g, '')

export interface NormalizeResult {
  invoices: Invoice[]
  rows: Row[]
  unknownVendors: { name: string; pages: number[]; suggestedCoa: string }[]
}

/**
 * Claude 가 뱉은 원본 JSON에 마스터 테이블을 적용한다.
 *
 * 모델 추론에 맡기지 않고 여기서 결정적으로 처리하는 것들:
 *  - 벤더명 정식 표기로 교정 (별칭 매칭)
 *  - 카드번호가 문서에 없을 때 벤더 기본 카드 채우기
 *  - PAYMENT / COA 를 마스터 값으로 확정
 *  - 분할 합계 검산
 *  - 허용값을 벗어난 COA·지점 코드 색출
 */
export function normalize(raw: any, master: Master): NormalizeResult {
  const byName = new Map<string, (typeof master.vendors)[number]>()
  for (const v of master.vendors) {
    byName.set(key(v.canonicalName), v)
    for (const a of v.aliases) byName.set(key(a), v)
  }
  const cardByLast4 = new Map(master.cards.map((c) => [c.last4, c.cardId]))
  const validCoa = new Set(master.coa)
  const validLoc = new Set(master.locations.map((l) => l.code))

  const invoices: Invoice[] = []
  const rows: Row[] = []

  for (const [i, inv] of (raw?.invoices ?? []).entries()) {
    const invId = `inv-${i + 1}`
    const rowIds: string[] = []

    for (const [j, r] of (inv.rows ?? []).entries()) {
      const id = `${invId}-r${j + 1}`
      const needs = new Set<string>(Array.isArray(r.needs_review) ? r.needs_review : [])

      // 추출기가 각 필드마다 "문서에서 읽었는지 / 표에서 채웠는지"를 같이 준다.
      // 문서에서 읽은 값은 매핑이 덮어쓰지 않는다. 종이가 정본이다.
      const src = (f: string): 'document' | 'table' | 'none' => r.source?.[f] ?? 'table'

      const rawVendor = String(r.vendor_name ?? '').trim()
      const vendor = byName.get(key(rawVendor))

      // 벤더는 문서에서 읽되, 아는 거래처면 표기만 시트 정본으로 통일한다
      // (같은 거래처가 'Supply, Inc' / 'Supply Inc' 로 갈리면 집계가 깨진다).
      const vendorName = vendor?.canonicalName ?? rawVendor
      if (!vendor && rawVendor) needs.add('vendorName')

      const claimed = String(r.payment ?? '').trim().toUpperCase() as Payment | ''
      const rawCard = String(r.card_id ?? '').trim()
      const last4 = rawCard.match(/(\d{4})\s*$/)?.[1]

      // 문서가 결제수단을 말하고 있으면 그대로 쓴다. 아니면 그때 표를 본다.
      const payment: Payment | '' =
        src('payment') === 'document' && claimed
          ? claimed
          : vendor?.payment || claimed || ''
      if (!payment) needs.add('payment')

      let cardId = ''
      if (payment === 'CARD') {
        // 영수증에 찍힌 끝 4자리 > 표의 기본 카드
        cardId = (last4 && cardByLast4.get(last4)) || rawCard || vendor?.defaultCardId || ''
        if (!cardId || (last4 && !cardByLast4.has(last4) && !vendor?.defaultCardId)) {
          needs.add('cardId')
        }
      }

      // 품목으로 판단한 COA 가 허용값이면 그걸 쓰고, 애매할 때만 벤더 기본값.
      const claimedCoa = String(r.coa ?? '')
      const coa =
        validCoa.has(claimedCoa) && (src('coa') === 'document' || !vendor?.defaultCoa)
          ? claimedCoa
          : vendor?.defaultCoa || (validCoa.has(claimedCoa) ? claimedCoa : '')
      if (!coa || !validCoa.has(coa)) needs.add('coa')

      // 지점은 근거가 있을 때만 인정한다. 표에는 지점을 추론할 근거가 없다.
      const rawLoc = String(r.location ?? '').trim().toUpperCase()
      const location = src('location') === 'document' && validLoc.has(rawLoc) ? rawLoc : ''
      if (!location) needs.add('location')

      const amount = Number(r.amount)
      if (!Number.isFinite(amount) || amount === 0) needs.add('amount')

      const date = String(r.date ?? '').trim()
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) needs.add('date')

      const invoiceNumber = String(r.invoice_number ?? '').trim()
      if (!invoiceNumber) needs.add('invoiceNumber')

      rows.push({
        id,
        date,
        invoiceNumber,
        vendorName,
        coa,
        amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0,
        payment,
        cardId,
        location: validLoc.has(location) ? location : '',
        memo: String(r.memo ?? ''),
        sourcePages: (inv.source_pages ?? []).map(Number),
        needsReview: [...needs],
        sources: {
          vendorName: rawVendor ? 'document' : 'none',
          date: 'document',
          invoiceNumber: 'document',
          amount: 'document',
          payment: payment ? (src('payment') === 'document' && claimed ? 'document' : 'table') : 'none',
          cardId: cardId ? (last4 && cardByLast4.has(last4) ? 'document' : 'table') : 'none',
          coa: coa ? (coa === claimedCoa && src('coa') === 'document' ? 'document' : 'table') : 'none',
          location: location ? 'document' : 'none',
        },
        boxes: parseBoxes(r.boxes),
        editedFields: [],
      })
      rowIds.push(id)
    }

    // 분할 합계 검산은 모델 답변을 믿지 않고 여기서 다시 계산한다.
    const total = Number(inv.printed_total)
    const sum = rowIds.reduce((a, id) => a + (rows.find((x) => x.id === id)?.amount ?? 0), 0)
    let splitCheck: Invoice['splitCheck'] = 'n/a'
    let splitDelta: number | null = null
    if (Number.isFinite(total) && rowIds.length > 0) {
      splitDelta = Math.round((sum - total) * 100) / 100
      splitCheck = Math.abs(splitDelta) < 0.005 ? 'ok' : 'mismatch'
    }

    invoices.push({
      id: invId,
      sourcePages: (inv.source_pages ?? []).map(Number),
      vendorName: rows.find((x) => x.id === rowIds[0])?.vendorName ?? '',
      invoiceNumber: String(inv.invoice_number ?? ''),
      date: String(inv.date ?? ''),
      printedTotal: Number.isFinite(total) ? total : null,
      splitCheck,
      splitDelta,
      confidence: (inv.confidence as Invoice['confidence']) ?? 'medium',
      notes: String(inv.notes ?? ''),
      rowIds,
    })
  }

  return {
    invoices,
    rows,
    unknownVendors: (raw?.unknown_vendors ?? []).map((u: any) => ({
      name: String(u.name ?? ''),
      pages: (u.pages ?? []).map(Number),
      suggestedCoa: String(u.suggested_coa ?? ''),
    })),
  }
}

/**
 * 모델이 준 위치 정보를 걸러 낸다.
 *
 * 화면 밖이거나 뒤집힌 사각형은 잘못 짚은 것이므로 버린다. 엉뚱한 곳을 가리키면
 * 검토가 오히려 느려진다.
 */
function parseBoxes(raw: any): Record<string, FieldBox> {
  const out: Record<string, FieldBox> = {}
  if (!raw || typeof raw !== 'object') return out

  // 모델은 invoice_number 처럼 주고 표는 invoiceNumber 로 찾는다. 여기서 맞춰 두지
  // 않으면 표시는 되는데 칸을 눌러도 강조되지 않는다.
  const rename: Record<string, string> = {
    invoice_number: 'invoiceNumber',
    vendor_name: 'vendorName',
    card_id: 'cardId',
    sub_vendor: 'vendorName',
    coa: 'coa',
    amount: 'amount',
    date: 'date',
    location: 'location',
    payment: 'payment',
  }

  for (const [rawField, v] of Object.entries<any>(raw)) {
    const field = rename[rawField] ?? rawField
    const page = Number(v?.page)
    const b = v?.box
    if (!Number.isFinite(page) || page < 1 || !Array.isArray(b) || b.length !== 4) continue

    const [x0, y0, x1, y1] = b.map(Number)
    if (![x0, y0, x1, y1].every((n) => Number.isFinite(n) && n >= 0 && n <= 1000)) continue
    if (x1 <= x0 || y1 <= y0) continue

    // 모델 좌표는 몇 % 씩 어긋나는 일이 잦다. 조금 넉넉히 잡아야 값이 테두리 안에 들어온다.
    const padX = Math.max(6, (x1 - x0) * 0.08)
    const padY = Math.max(6, (y1 - y0) * 0.35)
    out[field] = {
      page,
      box: [
        Math.max(0, x0 - padX),
        Math.max(0, y0 - padY),
        Math.min(1000, x1 + padX),
        Math.min(1000, y1 + padY),
      ],
    }
  }
  return out
}

/** 예시 파일과 같은 FileName 문자열을 만든다: YYYY.MM.DD-지점-법인-벤더-벤더-인보이스-금액 */
export function buildFileName(row: Row, corp = 'SCR'): string {
  const [mm, dd, yyyy] = row.date.split('/')
  const date = yyyy && mm && dd ? `${yyyy}.${mm}.${dd}` : row.date
  return [date, row.location, corp, row.vendorName, row.vendorName, row.invoiceNumber, row.amount.toFixed(2)]
    .join('-')
}

/** 페이지 누락·중복 검사. 모델이 페이지를 건너뛰면 여기서 잡힌다. */
export function checkPageCoverage(invoices: Invoice[], pageCount: number) {
  const seen = new Map<number, number>()
  for (const inv of invoices) for (const p of inv.sourcePages) seen.set(p, (seen.get(p) ?? 0) + 1)
  const missing: number[] = []
  for (let p = 1; p <= pageCount; p++) if (!seen.has(p)) missing.push(p)
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p)
  return { missing, duplicated, ok: missing.length === 0 && duplicated.length === 0 }
}


/**
 * 저장된 원본 JSON 에 지금의 매핑 기준표를 다시 적용한다.
 *
 * 매핑 시트를 고친 뒤 과거 이력에도 반영하고 싶을 때 쓴다.
 * 사람이 직접 고친 칸(editedFields)은 그대로 둔다 — 손으로 확인한 값이
 * 자동 계산 결과로 덮이면 검토한 의미가 없어진다.
 */
export function reapply(raw: any, master: Master, previous: Row[]): NormalizeResult {
  const fresh = normalize(raw, master)
  const byId = new Map(previous.map((r) => [r.id, r]))

  fresh.rows = fresh.rows.map((r) => {
    const old = byId.get(r.id)
    if (!old || old.editedFields.length === 0) return r

    const merged: Row = { ...r, editedFields: old.editedFields }
    for (const f of old.editedFields) {
      ;(merged as any)[f] = (old as any)[f]
      merged.needsReview = merged.needsReview.filter((x) => x !== f)
    }
    return merged
  })

  return fresh
}
