/**
 * Một bản ghi hóa đơn từ API traCuuHDDTTheoMST.
 * Được lưu vào collection `invoice_items`, unique theo `ID_HDON`.
 *
 * Chiến lược tránh tải trùng:
 *   - Mỗi lần tra cứu → upsert tất cả `ID_HDON` vào collection.
 *   - Trước khi gọi API PDF: kiểm tra `pdfDownloads.<fileType>.status === "ok"`.
 *     Nếu đã ok → bỏ qua, không tải lại.
 */
export interface InvoiceItem {
  // ── Dữ liệu gốc từ CPC API ──────────────────────────────────────────────
  MA_DVIQLY: string;       // Mã đơn vị quản lý (PC01AA, PC03DD…)
  MA_KHANG: string;        // Mã khách hàng (unique per meter)
  TEN_KHANG: string;
  DCHI_KHANG: string;
  KY: string;              // Kỳ hóa đơn ("1" | "2")
  THANG: string;           // Tháng ("03")
  NAM: string;             // Năm ("2026")
  ID_HDON: number;         // ID hóa đơn — khóa duy nhất trong collection
  SO_TIEN: number;
  TIEN_GTGT: number;
  TONG_TIEN: number;
  DIEN_TTHU: number;
  LOAI_PSINH: string;
  LOAI_HDON: string;
  LOAI_HOA_DON: string;
  MA_SOGCS: string;
  KIHIEU_SERY: string;
  SO_SERY: string;
  XEMTB: string | null;    // "Xem thông báo" nếu có
  XEMHD: string | null;    // "Xem hóa đơn" nếu có
  TAIVE: string | null;    // "Tải về" nếu có
  NGAY_PHANH: string;      // ISO date string
  TINH_TRANG: string | null;
  KY_HOA_DON: string | null;
  isShareData: unknown | null;

  // ── Metadata hệ thống ────────────────────────────────────────────────────
  /** Thời điểm ID_HDON này xuất hiện lần đầu tiên */
  firstSeenAt: Date;
  /** Thời điểm upsert gần nhất */
  lastSeenAt: Date;
  /** Số lần bắt gặp trong các lần tra cứu (tăng mỗi lần upsert) */
  fetchCount: number;

  /**
   * Trạng thái tải PDF, keyed theo fileType ("TBAO" | "HDON").
   * Dùng để skip tải lại: nếu `pdfDownloads.TBAO.status === "ok"` → đã có file.
   *
   * Ví dụ sau khi tải thành công:
   * {
   *   "TBAO": { status: "ok", filePath: "./output/pdfs/pc01aa/...", bytes: 45321, downloadedAt: ... }
   * }
   */
  pdfDownloads?: Partial<Record<PdfFileType, PdfDownloadRecord>>;
}

export type PdfFileType = "TBAO" | "HDON";

export interface PdfDownloadRecord {
  status: "ok" | "error";
  downloadedAt: Date;
  /** Đường dẫn file trên disk (rỗng nếu status=error) */
  filePath: string;
  /** Kích thước file tính bằng byte (0 nếu error) */
  bytes: number;
  /** Thông báo lỗi nếu status=error */
  error?: string;
}

/** Response thô từ API traCuuHDDTTheoMST */
export interface TraCuuHDDTResponse {
  result: RawInvoiceItem[];
}

/** Dữ liệu thô từ CPC — chỉ các field từ API, chưa có metadata hệ thống */
export type RawInvoiceItem = Omit<
  InvoiceItem,
  "firstSeenAt" | "lastSeenAt" | "fetchCount" | "pdfDownloads"
>;

/** Response từ API tải PDF: /api/remote/invoice/file/pdf */
export interface CpcPdfApiResponse {
  /** Nội dung PDF dưới dạng base64 */
  pdf: string | null;
  html: string | null;
  pdfDetail: string | null;
  htmlDetail: string | null;
  signedXml: string | null;
}
