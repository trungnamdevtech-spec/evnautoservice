import type { Collection } from "mongodb";
import { getMongoDb } from "./mongo.js";
import type { InvoiceItem, PdfDownloadRecord, PdfFileType, RawInvoiceItem } from "../types/invoiceItem.js";

const COLLECTION = "invoice_items";

export interface UpsertResult {
  inserted: number;
  updated: number;
  total: number;
  newItems: Pick<InvoiceItem, "ID_HDON" | "MA_KHANG" | "TONG_TIEN" | "NGAY_PHANH">[];
}

export interface InvoicePdfRef {
  invoiceId: number;
  maKhachHang: string;
  ky: string;
  thang: string;
  nam: string;
  ngayPhatHanh: string;
  fileType: PdfFileType;
  filePath: string;
  bytes: number;
  downloadedAt: Date;
}

export class InvoiceItemRepository {
  private colPromise: Promise<Collection<InvoiceItem>> | null = null;

  private async col(): Promise<Collection<InvoiceItem>> {
    if (!this.colPromise) {
      this.colPromise = (async () => {
        const db = await getMongoDb();
        const c = db.collection<InvoiceItem>(COLLECTION);
        await c.createIndex({ ID_HDON: 1 }, { unique: true, background: true }).catch(() => undefined);
        await c.createIndex({ MA_KHANG: 1, KY: 1, THANG: 1, NAM: 1 }, { background: true }).catch(() => undefined);
        return c;
      })();
    }
    return this.colPromise;
  }

  /**
   * Upsert danh sách hóa đơn theo `ID_HDON`.
   * - Nếu chưa có → insert với `firstSeenAt`, `fetchCount=1`
   * - Nếu đã có → cập nhật `lastSeenAt`, tăng `fetchCount`
   * Không bao giờ ghi đè `pdfDownloads` — chỉ cập nhật riêng qua `markPdfDownloaded`.
   */
  async upsertMany(items: RawInvoiceItem[]): Promise<UpsertResult> {
    if (items.length === 0) {
      return { inserted: 0, updated: 0, total: 0, newItems: [] };
    }

    const c = await this.col();
    const now = new Date();

    const existingIds = new Set(
      (await c.find({ ID_HDON: { $in: items.map((i) => i.ID_HDON) } }, { projection: { ID_HDON: 1 } }).toArray()).map(
        (d) => d.ID_HDON,
      ),
    );

    const ops = items.map((item) => {
      const isNew = !existingIds.has(item.ID_HDON);
      return {
        updateOne: {
          filter: { ID_HDON: item.ID_HDON },
          update: {
            $set: {
              ...item,
              lastSeenAt: now,
            },
            $setOnInsert: {
              firstSeenAt: now,
            },
            $inc: { fetchCount: 1 },
          },
          upsert: true,
        },
      };
    });

    const result = await c.bulkWrite(ops, { ordered: false });

    const inserted = result.upsertedCount;
    const updated = result.modifiedCount;
    const newItems = items
      .filter((i) => !existingIds.has(i.ID_HDON))
      .map((i) => ({
        ID_HDON: i.ID_HDON,
        MA_KHANG: i.MA_KHANG,
        TONG_TIEN: i.TONG_TIEN,
        NGAY_PHANH: i.NGAY_PHANH,
      }));

    return { inserted, updated, total: items.length, newItems };
  }

  async findByKyThangNam(ky: string, thang: string, nam: string): Promise<InvoiceItem[]> {
    const c = await this.col();
    // Nếu cả 3 đều rỗng → trả toàn bộ (dùng cho parse-all-pdfs)
    const filter = ky || thang || nam ? { KY: ky, THANG: thang, NAM: nam } : {};
    return c.find(filter).sort({ NGAY_PHANH: 1 }).toArray();
  }

  /**
   * Ghi lại kết quả tải PDF (thành công hoặc lỗi) cho một hóa đơn.
   * Lưu theo key `pdfDownloads.<fileType>` (TBAO | HDON).
   * Ghi đè record cũ nếu đã tồn tại (ví dụ retry sau lỗi).
   */
  async markPdfDownloaded(
    idHdon: number,
    fileType: PdfFileType,
    record: PdfDownloadRecord,
  ): Promise<void> {
    const c = await this.col();
    await c.updateOne(
      { ID_HDON: idHdon },
      { $set: { [`pdfDownloads.${fileType}`]: record, lastSeenAt: new Date() } },
    );
  }

  /**
   * Trả về danh sách hóa đơn chưa tải PDF (status != "ok") trong kỳ/tháng/năm.
   * Dùng để tìm hóa đơn cần tải lại sau lỗi.
   */
  async findPendingPdfDownload(
    ky: string,
    thang: string,
    nam: string,
    fileType: PdfFileType,
  ): Promise<InvoiceItem[]> {
    const c = await this.col();
    return c
      .find({
        KY: ky,
        THANG: thang,
        NAM: nam,
        $or: [
          { [`pdfDownloads.${fileType}`]: { $exists: false } },
          { [`pdfDownloads.${fileType}.status`]: "error" },
        ],
      })
      .sort({ NGAY_PHANH: 1 })
      .toArray();
  }

  /** Lấy metadata PDF thành công theo invoiceId + fileType */
  async findPdfRefByInvoiceId(
    invoiceId: number,
    fileType: PdfFileType,
  ): Promise<InvoicePdfRef | null> {
    const c = await this.col();
    const doc = await c.findOne({
      ID_HDON: invoiceId,
      [`pdfDownloads.${fileType}.status`]: "ok",
    });
    if (!doc) return null;
    const record = doc.pdfDownloads?.[fileType];
    if (!record || record.status !== "ok" || !record.filePath) return null;
    return {
      invoiceId: doc.ID_HDON,
      maKhachHang: doc.MA_KHANG,
      ky: doc.KY,
      thang: doc.THANG,
      nam: doc.NAM,
      ngayPhatHanh: doc.NGAY_PHANH,
      fileType,
      filePath: record.filePath,
      bytes: record.bytes,
      downloadedAt: record.downloadedAt,
    };
  }

  /**
   * Lấy PDF mới nhất của một mã khách hàng.
   * Có thể filter thêm ky/thang/nam.
   */
  async findLatestPdfRefByCustomer(
    maKhachHang: string,
    fileType: PdfFileType,
    opts: { ky?: string; thang?: string; nam?: string } = {},
  ): Promise<InvoicePdfRef | null> {
    const c = await this.col();
    const filter: Record<string, unknown> = {
      MA_KHANG: maKhachHang.toUpperCase(),
      [`pdfDownloads.${fileType}.status`]: "ok",
    };
    if (opts.ky) filter.KY = opts.ky;
    if (opts.thang) filter.THANG = opts.thang;
    if (opts.nam) filter.NAM = opts.nam;

    const doc = await c.findOne(filter, { sort: { NGAY_PHANH: -1, ID_HDON: -1 } });
    if (!doc) return null;
    const record = doc.pdfDownloads?.[fileType];
    if (!record || record.status !== "ok" || !record.filePath) return null;
    return {
      invoiceId: doc.ID_HDON,
      maKhachHang: doc.MA_KHANG,
      ky: doc.KY,
      thang: doc.THANG,
      nam: doc.NAM,
      ngayPhatHanh: doc.NGAY_PHANH,
      fileType,
      filePath: record.filePath,
      bytes: record.bytes,
      downloadedAt: record.downloadedAt,
    };
  }

  /**
   * Liệt kê PDF đã tải OK của 1 khách hàng, có lọc ky/tháng/năm (khớp cách lưu DB: THANG không leading zero).
   */
  async listPdfRefsByCustomerFiltered(
    maKhachHang: string,
    fileType: PdfFileType,
    opts: { ky?: string; thang?: string; nam?: string },
    limit = 500,
  ): Promise<InvoicePdfRef[]> {
    const c = await this.col();
    const filter: Record<string, unknown> = {
      MA_KHANG: maKhachHang.toUpperCase(),
      [`pdfDownloads.${fileType}.status`]: "ok",
    };
    if (opts.ky !== undefined && opts.ky !== "") filter.KY = String(Number.parseInt(opts.ky, 10));
    if (opts.thang !== undefined && opts.thang !== "") {
      const t = Number.parseInt(opts.thang, 10);
      if (Number.isFinite(t) && t >= 1 && t <= 12) filter.THANG = String(t);
    }
    if (opts.nam !== undefined && opts.nam !== "") filter.NAM = String(opts.nam);

    const docs = await c
      .find(filter)
      .sort({ NGAY_PHANH: 1, ID_HDON: 1 })
      .limit(Math.min(Math.max(limit, 1), 2000))
      .toArray();

    return this.docsToPdfRefs(docs, fileType);
  }

  /**
   * Tất cả PDF đã OK trong một kỳ/tháng/năm (mọi khách hàng).
   */
  async listPdfRefsByPeriod(
    ky: string,
    thang: string,
    nam: string,
    fileType: PdfFileType,
    limit = 500,
  ): Promise<InvoicePdfRef[]> {
    const c = await this.col();
    const docs = await c
      .find({
        KY: String(Number.parseInt(ky, 10)),
        THANG: String(Number.parseInt(thang, 10)),
        NAM: String(nam),
        [`pdfDownloads.${fileType}.status`]: "ok",
      })
      .sort({ MA_KHANG: 1, NGAY_PHANH: 1, ID_HDON: 1 })
      .limit(Math.min(Math.max(limit, 1), 2000))
      .toArray();

    return this.docsToPdfRefs(docs, fileType);
  }

  private docsToPdfRefs(docs: InvoiceItem[], fileType: PdfFileType): InvoicePdfRef[] {
    const out: InvoicePdfRef[] = [];
    for (const doc of docs) {
      const record = doc.pdfDownloads?.[fileType];
      if (!record || record.status !== "ok" || !record.filePath) continue;
      out.push({
        invoiceId: doc.ID_HDON,
        maKhachHang: doc.MA_KHANG,
        ky: doc.KY,
        thang: doc.THANG,
        nam: doc.NAM,
        ngayPhatHanh: doc.NGAY_PHANH,
        fileType,
        filePath: record.filePath,
        bytes: record.bytes,
        downloadedAt: record.downloadedAt,
      });
    }
    return out;
  }

  /** Liệt kê metadata PDF đã tải thành công của 1 khách hàng (mới nhất trước). */
  async listPdfRefsByCustomer(
    maKhachHang: string,
    fileType: PdfFileType,
    limit = 100,
  ): Promise<InvoicePdfRef[]> {
    const c = await this.col();
    const docs = await c
      .find({
        MA_KHANG: maKhachHang.toUpperCase(),
        [`pdfDownloads.${fileType}.status`]: "ok",
      })
      .sort({ NGAY_PHANH: -1, ID_HDON: -1 })
      .limit(limit)
      .toArray();

    return this.docsToPdfRefs(docs, fileType);
  }
}
