import type { Invoice, Master, Payment, Row } from './types'

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

      const rawVendor = String(r.vendor_name ?? '').trim()
      const vendor = byName.get(key(rawVendor))

      // 마스터에 있으면 시트 표기를 정본으로 삼는다 (쉼표·마침표까지).
      const vendorName = vendor?.canonicalName ?? rawVendor
      if (!vendor && rawVendor) needs.add('vendorName')

      // 문서에 카드가 찍혀 있으면 그게 가장 확실한 증거다. 벤더 기본값보다 우선한다.
      // (같은 벤더라도 그날 카드로 긁었을 수 있고, 영수증은 거짓말하지 않는다.)
      const claimed = String(r.payment ?? '').trim().toUpperCase() as Payment | ''
      const rawCard = String(r.card_id ?? '').trim()
      const last4 = rawCard.match(/(\d{4})\s*$/)?.[1]
      const cardEvidence = claimed === 'CARD' && !!last4

      const payment: Payment | '' = cardEvidence ? 'CARD' : vendor?.payment || claimed || ''
      if (!payment) needs.add('payment')

      let cardId = ''
      if (payment === 'CARD') {
        cardId = (last4 && cardByLast4.get(last4)) || rawCard || vendor?.defaultCardId || ''
        // 매핑에 없는 카드 번호는 사람이 확인해야 한다.
        if (!cardId || (last4 && !cardByLast4.has(last4) && !vendor?.defaultCardId)) {
          needs.add('cardId')
        }
      }

      const coa = validCoa.has(String(r.coa ?? '')) ? String(r.coa) : vendor?.defaultCoa || ''
      if (!coa || !validCoa.has(coa)) needs.add('coa')

      const location = String(r.location ?? '').trim().toUpperCase()
      if (!location || !validLoc.has(location)) needs.add('location')

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
