/**
 * Một dòng trong mảng `billData` trả về từ TraCuuHDSPC (script trên trang).
 * Các field bổ sung giữ nguyên từ JSON gốc.
 */
export interface NpcTraCuuBillRow {
  id_hdon: string;
  customer_code?: string;
  period?: string;
  month?: string;
  year?: string;
  series?: string;
  amount?: string;
  invoice_type?: string;
  consumption?: string;
  loan_status?: string;
  bool2TP?: string;
  PhienBan?: string;
  [key: string]: unknown;
}
