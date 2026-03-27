/**
 * ID số dùng trong ElectricityBill.invoiceId cho nguồn NPC (không trùng kiểu ID_HDON CPC).
 * Phạm vi 9_000_000_000 … 9_999_999_999 — tránh đè lên ID CPC thực.
 */
export function npcInvoiceIdSurrogateFromIdHdon(idHdon: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < idHdon.length; i++) {
    h ^= idHdon.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 9_000_000_000 + (h % 999_999_999);
}

export function npcBillKey(idHdon: string): string {
  return `npc:${idHdon}`;
}
