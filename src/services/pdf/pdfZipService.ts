import archiver from "archiver";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { logger } from "../../core/logger.js";
import type { InvoicePdfRef } from "../../db/invoiceItemRepository.js";

/**
 * Tên file trong ZIP — thống nhất với tải đơn lẻ `/api/pdf/invoice/:id`.
 * Các luồng khác (worker, script) nên import hàm này khi cần đặt tên file PDF trong gói.
 */
export function pdfEntryFileName(ref: InvoicePdfRef): string {
  return `${ref.maKhachHang}_${ref.invoiceId}_${ref.fileType}.pdf`;
}

/** Chỉ giữ ref có file tồn tại trên disk (một lần stat). */
export async function filterExistingPdfRefs(refs: InvoicePdfRef[]): Promise<InvoicePdfRef[]> {
  const out: InvoicePdfRef[] = [];
  for (const ref of refs) {
    const abs = path.resolve(ref.filePath);
    try {
      const s = await stat(abs);
      if (s.isFile()) out.push(ref);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Trả Response streaming ZIP hoặc `null` nếu không có file hợp lệ.
 */
export async function buildPdfZipResponse(
  refs: InvoicePdfRef[],
  downloadFileName: string,
): Promise<Response | null> {
  const existing = await filterExistingPdfRefs(refs);
  if (existing.length === 0) {
    return null;
  }

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("warning", (err: unknown) => logger.warn("[pdfZip]", err));
  archive.on("error", (err: unknown) => logger.error("[pdfZip] archive error:", err));

  for (const ref of existing) {
    const abs = path.resolve(ref.filePath);
    archive.file(abs, { name: pdfEntryFileName(ref) });
  }

  void archive.finalize();

  const safeName = downloadFileName.endsWith(".zip") ? downloadFileName : `${downloadFileName}.zip`;
  const web = Readable.toWeb(archive);
  return new Response(web as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    },
  });
}
