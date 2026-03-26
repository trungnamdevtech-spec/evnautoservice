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
}
