/**
 * Khóa và invoiceId surrogate cho `electricity_bills` — provider EVN_HANOI.
 * Tách hai PDF cùng idHdon (tiền điện vs GTGT) giống logic NPC thong_bao/thanh_toan.
 */
export type HanoiPdfKind = "tien_dien" | "gtgt";

export function hanoiBillKey(idHdon: string, kind: HanoiPdfKind): string {
  return kind === "gtgt" ? `hanoi:gtgt:${idHdon}` : `hanoi:td:${idHdon}`;
}

/** Phạm vi 8_000_000_000 … 8_999_999_999 — không trùng CPC/NPC. */
export function hanoiInvoiceIdSurrogateFromIdHdon(idHdon: string, kind: HanoiPdfKind): number {
  const input = kind === "gtgt" ? `${idHdon}\0HANOI_GTGT` : `${idHdon}\0HANOI_TD`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 8_000_000_000 + (h % 999_999_999);
}
