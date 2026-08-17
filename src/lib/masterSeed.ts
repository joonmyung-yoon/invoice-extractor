import type { Master } from './types'

/**
 * 마스터 시트 초기 내용.
 *
 * vendors / cards / coa 는 samples/invoice_extract_example.xlsx 의 170행을 집계해서 뽑았다.
 * (각 벤더의 PAYMENT·CARD_ID·COA 는 표본 안에서 사실상 하나로 고정되어 있었다.)
 *
 * locations 는 스캔본에서 실제로 확인된 상호/주소만 채워져 있다. SWC·TBC 는 표본에
 * 배송지 근거가 없어 비어 있으니 사용자가 시트에서 채워야 한다.
 */
export const MASTER_SEED: Master = {
  coa: [
    'COGS:Food Cost',
    'COGS:Supplies',
    'COGS:Meat Products',
    'COGS:Liquor Cost',
    'Fringe Benefit:Employee Meals',
    'Fringe Benefit:Transp/Housing',
  ],

  cards: [
    { last4: '3312', cardId: 'SCR-3312', notes: 'COSTCO 주력' },
    { last4: '0463', cardId: 'SCR-0463', notes: '범용' },
    { last4: '9555', cardId: 'SCR-9555', notes: 'AMAZON' },
    { last4: '0738', cardId: 'SCR-0738', notes: '' },
    { last4: '7948', cardId: 'SCR-7948', notes: 'COSTCO 보조' },
  ],

  locations: [
    { code: 'STN', name: 'Seoul Tang & Noodle', hints: ['STN(BP)', 'K-340', 'k316', '6924 Beach Blvd'] },
    { code: 'IFO', name: 'IL FIORA', hints: ['IL FIORA(FUR)', 'C330', '6982 Beach Pl'] },
    { code: 'ODG', name: 'M Korean BBQ', hints: ['C-320', 'C320'] },
    { code: 'SWC', name: '', hints: [] },
    { code: 'TBC', name: '', hints: [] },
  ],

  vendors: [
    { canonicalName: 'Greenland Foods Company', aliases: [], payment: 'CHECK', defaultCardId: '', defaultCoa: 'COGS:Food Cost', notes: '' },
    { canonicalName: 'COSTCO', aliases: ['COSTCO WHOLESALE'], payment: 'CARD', defaultCardId: 'SCR-3312', defaultCoa: 'COGS:Food Cost', notes: '영수증 하단 손글씨로 지점 분할되는 경우가 많음' },
    { canonicalName: 'Apex Mongr Inc', aliases: [], payment: 'CHECK', defaultCardId: '', defaultCoa: 'COGS:Meat Products', notes: '' },
    { canonicalName: 'Sysco', aliases: ['SYSCO LOS ANGELES, INC.', 'ASIAN FOODS'], payment: 'ACH', defaultCardId: '', defaultCoa: 'COGS:Food Cost', notes: '여러 장짜리 인보이스. 총액은 LAST PAGE 에만 있음' },
    { canonicalName: 'Dream Factory Supply, Inc', aliases: ['Dream Factory Supply Inc'], payment: 'CHECK', defaultCardId: '', defaultCoa: 'COGS:Supplies', notes: '' },
    { canonicalName: 'S.J. Distributors Inc.', aliases: ['SJ Distributors', 'S.J. Distributors Inc', 'S.J. Distributors LLC'], payment: 'CARD', defaultCardId: 'SCR-0463', defaultCoa: 'COGS:Food Cost', notes: '납품 인보이스에 카드번호가 안 찍히므로 기본 카드 사용' },
    { canonicalName: 'Wang Globalnet', aliases: [], payment: 'CHECK', defaultCardId: '', defaultCoa: 'COGS:Food Cost', notes: '' },
    { canonicalName: 'AMAZON', aliases: ['Amazon.com', 'AMZN'], payment: 'CARD', defaultCardId: 'SCR-9555', defaultCoa: 'COGS:Supplies', notes: '' },
    { canonicalName: 'J&B Distribution Services Corp', aliases: [], payment: 'CHECK', defaultCardId: '', defaultCoa: 'COGS:Food Cost', notes: '' },
    { canonicalName: 'USFOODS', aliases: ['US FOODS', 'U.S. FOODS'], payment: 'ACH', defaultCardId: '', defaultCoa: 'COGS:Food Cost', notes: '' },
    { canonicalName: 'Woo Kee Inc. Co', aliases: [], payment: 'CHECK', defaultCardId: '', defaultCoa: 'COGS:Food Cost', notes: '' },
    { canonicalName: 'Chefs Warehouse', aliases: ["Chef's Warehouse"], payment: 'CARD', defaultCardId: 'SCR-0738', defaultCoa: 'COGS:Food Cost', notes: '' },
    { canonicalName: 'American KGP. Inc.', aliases: ['American KGP Inc'], payment: 'CARD', defaultCardId: 'SCR-0738', defaultCoa: 'COGS:Food Cost', notes: '' },
    { canonicalName: 'TARGET', aliases: [], payment: 'CARD', defaultCardId: 'SCR-0463', defaultCoa: 'COGS:Supplies', notes: '' },
    { canonicalName: 'K P Global Inc', aliases: ['KP Global'], payment: 'ACH', defaultCardId: '', defaultCoa: 'COGS:Liquor Cost', notes: '' },
    { canonicalName: 'ZOOMAK', aliases: [], payment: 'CARD', defaultCardId: 'SCR-0463', defaultCoa: 'Fringe Benefit:Employee Meals', notes: '' },
    { canonicalName: 'Yosemite Valley Beef Distributors', aliases: [], payment: 'CHECK', defaultCardId: '', defaultCoa: 'COGS:Meat Products', notes: '' },
    { canonicalName: 'SPEEDWAY EXPRESS', aliases: [], payment: 'CARD', defaultCardId: 'SCR-0463', defaultCoa: 'Fringe Benefit:Transp/Housing', notes: '' },
    { canonicalName: 'WALMART', aliases: ['Wal-Mart'], payment: 'CARD', defaultCardId: 'SCR-0463', defaultCoa: 'COGS:Supplies', notes: '' },
    { canonicalName: 'DPOT', aliases: [], payment: 'CARD', defaultCardId: 'SCR-0463', defaultCoa: 'Fringe Benefit:Employee Meals', notes: '' },
    { canonicalName: 'Oil Stop', aliases: ['Oilstop', 'Oilstop Drive Thru Oil Change'], payment: 'CARD', defaultCardId: 'SCR-0463', defaultCoa: 'Fringe Benefit:Transp/Housing', notes: '' },
  ],

  syncedAt: null,
}

/** 구글시트 탭 이름과 헤더. 시트 초기화·동기화 양쪽에서 쓴다. */
export const SHEET_TABS = {
  Vendors: ['canonical_name', 'aliases', 'payment', 'default_card_id', 'default_coa', 'notes'],
  Cards: ['last4', 'card_id', 'notes'],
  Locations: ['code', 'name', 'hints'],
  COA: ['coa'],
} as const
