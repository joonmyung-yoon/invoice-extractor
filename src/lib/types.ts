// 시트 출력 컬럼(예시 파일과 동일한 순서). 빈 칸으로 두는 컬럼도 형식을 맞추기 위해 유지한다.
// 실제 장부에 붙여넣는 컬럼. 처음 받은 예시 파일은 다른 시트였고, 아래가 맞는 형식이다.
//
// 주의할 점 두 가지:
//  - vendor 는 법인명(고정)이고, 실제 거래처는 sub-vendor 다. 둘이 뒤바뀌기 쉽다.
//  - pageno/pages 는 그 인보이스가 PDF 몇 번째 장에서 몇 장에 걸쳐 있는지다.
export const OUTPUT_COLUMNS = [
  'buyer',
  'date',
  'invoiceno',
  'vendor',
  'sub-vendor',
  'cogs',
  'amt',
  'pageno',
  'pages',
  'payment',
  'card id',
] as const

/** 모든 행에 같은 값이 들어가는 법인명. */
export const BUYER_ENTITY = 'Southern California Restaurant Company'

export type Payment = 'CARD' | 'CHECK' | 'ACH'

/** 원본 페이지에서 값을 읽어온 자리. box 는 [x0, y0, x1, y1], 0~1000 기준. */
export interface FieldBox {
  page: number
  box: [number, number, number, number]
}

/** 추출 결과 한 행. 시트 한 줄에 대응한다. */
export interface Row {
  id: string
  /** MM/DD/YYYY */
  date: string
  invoiceNumber: string
  vendorName: string
  coa: string
  amount: number
  payment: Payment | ''
  cardId: string
  location: string
  memo: string
  /** 이 행이 나온 원본 페이지(1-based) */
  sourcePages: number[]
  /** 사람이 손대야 하는 칸. 값이 없거나 근거가 약한 필드명이 들어간다. */
  needsReview: string[]
  /** 각 값의 출처. 'table' 은 인보이스에 없어서 매핑으로 채웠다는 뜻이다. */
  sources: Record<string, 'document' | 'table' | 'none'>
  /** 원본에서 그 값을 읽어온 위치. 페이지 크기 대비 1/1000 단위 사각형. */
  boxes: Record<string, FieldBox>
  /** 사용자가 직접 고친 필드명. 재추출해도 덮어쓰지 않는다. */
  editedFields: string[]
}

/** 페이지 묶음 = 인보이스 1건. 행 여러 개로 쪼개질 수 있다. */
export interface Invoice {
  id: string
  sourcePages: number[]
  vendorName: string
  invoiceNumber: string
  date: string
  printedTotal: number | null
  /** 분할 합계 검산 결과 */
  splitCheck: 'ok' | 'mismatch' | 'n/a'
  splitDelta: number | null
  confidence: 'high' | 'medium' | 'low'
  notes: string
  rowIds: string[]
}

export interface Job {
  id: string
  pdfName: string
  pdfPath: string
  pageCount: number
  createdAt: string
  status: 'pending' | 'rendering' | 'extracting' | 'done' | 'error'
  error: string | null
  promptId: string | null
  promptSnapshot: string
  invoices: Invoice[]
  rows: Row[]
}

export interface Prompt {
  id: string
  name: string
  body: string
  createdAt: string
  /** 기본 제공 프롬프트는 삭제할 수 없다. */
  builtin: boolean
}

// ── 마스터 데이터 (구글시트에서 동기화) ────────────────────────────

export interface VendorRule {
  /** 시트에 기록되는 정식 표기 */
  canonicalName: string
  /** 스캔본에 나타나는 다른 표기들 */
  aliases: string[]
  payment: Payment | ''
  defaultCardId: string
  defaultCoa: string
  notes: string
}

export interface CardRule {
  /** 영수증에 찍히는 카드 끝 4자리 */
  last4: string
  cardId: string
  notes: string
}

export interface LocationRule {
  code: string
  /** 배송지에 찍히는 상호명 */
  name: string
  /** 주소 조각 등 판별 단서 */
  hints: string[]
}

export interface Master {
  vendors: VendorRule[]
  cards: CardRule[]
  locations: LocationRule[]
  coa: string[]
  syncedAt: string | null
}

export const EMPTY_MASTER: Master = {
  vendors: [],
  cards: [],
  locations: [],
  coa: [],
  syncedAt: null,
}
