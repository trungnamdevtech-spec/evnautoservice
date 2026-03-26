import type { ObjectId } from "mongodb";

export type TaskStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

/** Metadata sau khi tải thành công — mở rộng khi có PDF pipeline */
export interface InvoiceDownloadMetadata {
  downloadedAt: string;
  /** Đường dẫn lưu tạm / object key — tùy storage backend */
  storageRef?: string;
  mimeType?: string;
  originalFileName?: string;
  bytes?: number;
  /** Dữ liệu từ form tra cứu (bill number, customer id, ...) */
  lookupPayload?: Record<string, unknown>;
  /** Kết quả upsert danh sách hóa đơn vào invoice_items */
  invoiceSync?: {
    total: number;
    inserted: number;
    updated: number;
    newIds: number[];
  };
  /** Kết quả tải PDF */
  pdfSync?: {
    attempted: number;
    success: number;
    failed: number;
    failedIds: number[];
  };
  /** Kết quả tự động parse PDF sau khi tải xong */
  parseSync?: {
    attempted: number;
    success: number;
    failed: number;
  };
}

export interface ScrapeTask {
  _id?: ObjectId;
  status: TaskStatus;
  workerId?: string;
  provider: "EVN_CPC";
  /** JSON string hoặc object — session/cookie cho storageState */
  sessionData?: string | Record<string, unknown>;
  /** period/ky, month/thang, year/nam — tra cứu hóa đơn CPC; mặc định kỳ 1 + tháng/năm hiện tại */
  payload: Record<string, unknown>;
  errorMessage?: string;
  resultMetadata?: InvoiceDownloadMetadata;
  createdAt: Date;
  updatedAt: Date;
}
