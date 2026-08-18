/**
 * PDF 를 조각으로 나눠 동시에 추출하기 위한 계산.
 *
 * 통째로 한 번에 돌리면 페이지당 10~15초가 그대로 쌓인다(24장이면 5분 이상).
 * 조각으로 나눠 동시에 돌리면 그 수만큼 시간이 줄어든다.
 */

/** 조각 하나가 맡을 최소 페이지 수. 너무 잘게 쪼개면 겹치는 비용이 더 커진다. */
const MIN_PAGES_PER_CHUNK = 4

/** 조각 경계에 걸친 여러 장짜리 인보이스가 잘리지 않도록 앞뒤로 겹치는 장수. */
const OVERLAP = 1

/** 각 조각이 맡을 페이지 번호(1-based) 목록. 모든 페이지가 최소 한 번은 포함된다. */
export function planChunks(pageCount: number, maxChunks: number): number[][] {
  const chunks = Math.max(1, Math.min(maxChunks, Math.floor(pageCount / MIN_PAGES_PER_CHUNK)))
  if (chunks <= 1) return [range(1, pageCount)]

  const size = Math.ceil(pageCount / chunks)
  const out: number[][] = []
  for (let start = 1; start <= pageCount; start += size) {
    const from = Math.max(1, start - (out.length ? OVERLAP : 0))
    const to = Math.min(pageCount, start + size - 1 + OVERLAP)
    out.push(range(from, to))
    if (to >= pageCount) break
  }
  return out
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

/**
 * 조각별 결과를 하나로 합친다.
 *
 * 겹친 페이지에서 같은 건이 두 번 나오므로 걸러 낸다. 판정은 인보이스 번호와
 * 금액으로 한다 — 조각이 다르면 페이지 묶음이 조금씩 다를 수 있어서 그것만으로는
 * 같은 건인지 알 수 없다.
 */
export function mergeResults(parts: any[]): any {
  const invoices: any[] = []
  const unknown = new Map<string, any>()
  const seen = new Set<string>()

  for (const part of parts) {
    for (const inv of part?.invoices ?? []) {
      const key = [
        String(inv.invoice_number ?? '').trim().toLowerCase(),
        inv.printed_total ?? '',
        (inv.rows ?? []).length,
      ].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      invoices.push(inv)
    }
    for (const u of part?.unknown_vendors ?? []) {
      if (u?.name && !unknown.has(u.name)) unknown.set(u.name, u)
    }
  }

  // 원본 순서대로 정렬해야 넘겨보며 대조하기 편하다.
  invoices.sort((a, b) => (a.source_pages?.[0] ?? 0) - (b.source_pages?.[0] ?? 0))
  return { invoices, unknown_vendors: [...unknown.values()] }
}
