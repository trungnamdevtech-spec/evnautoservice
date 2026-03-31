/**
 * ID số dùng trong ElectricityBill.invoiceId cho nguồn NPC (không trùng kiểu ID_HDON CPC).
 * Phạm vi 9_000_000_000 … 9_999_999_999 — tránh đè lên ID CPC thực.
 *
 * `thanh_toan` dùng chuỗi hash khác `thong_bao` để không trùng invoiceId giữa hai PDF cùng id_hdon.
 */
export type NpcPdfKind = "thong_bao" | "thanh_toan";

export function npcInvoiceIdSurrogateFromIdHdon(idHdon: string, kind: NpcPdfKind = "thong_bao"): number {
  const input = kind === "thanh_toan" ? `${idHdon}\0NPC_HOADON_THANH_TOAN` : idHdon;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 9_000_000_000 + (h % 999_999_999);
}

export function npcBillKey(idHdon: string, kind: NpcPdfKind = "thong_bao"): string {
  return kind === "thanh_toan" ? `npc:tt:${idHdon}` : `npc:${idHdon}`;
}
