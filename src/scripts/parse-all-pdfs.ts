/**
 * Scan toàn bộ thư mục output/pdfs, parse từng file PDF và lưu vào MongoDB.
 *
 * - Chỉ parse file chưa có hoặc parseVersion cũ hơn PARSER_VERSION hiện tại.
 * - Re-parse file có status="error" để retry sau khi sửa parser.
 * - Dùng thông tin từ invoice_items để lấy metadata (ID_HDON, MA_KHANG, ...).
 *
 * Usage:
 *   node --import tsx src/scripts/parse-all-pdfs.ts
 *   node --import tsx src/scripts/parse-all-pdfs.ts --force   (re-parse tất cả)
 */

import "dotenv/config";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { InvoiceItemRepository } from "../db/invoiceItemRepository.js";
import { ElectricityBillRepository } from "../db/electricityBillRepository.js";
import { parseElectricityBillPdf, PARSER_VERSION } from "../services/pdf/ElectricityBillParser.js";
import { env } from "../config/env.js";

const FORCE_REPARSE = process.argv.includes("--force");
const CONCURRENCY = 4; // parse N files song song

async function main(): Promise<void> {
  await getMongoDb();
  const invoiceRepo = new InvoiceItemRepository();
  const billRepo = new ElectricityBillRepository();

  console.info(`[parse-pdfs] Bắt đầu — force=${FORCE_REPARSE}, parserVersion=${PARSER_VERSION}`);
  console.info(`[parse-pdfs] Thư mục PDF: ${path.resolve(env.pdfOutputDir)}`);

  // 1. Thu thập tất cả file PDF trong output/pdfs/**/*.pdf
  const allPdfFiles = await collectPdfFiles(env.pdfOutputDir);
  console.info(`[parse-pdfs] Tìm thấy ${allPdfFiles.length} file PDF.`);

  if (allPdfFiles.length === 0) {
    console.warn("[parse-pdfs] Không có file PDF nào để xử lý.");
    await closeMongo();
    return;
  }

  // 2. Lấy toàn bộ invoice_items để tra metadata
  const allInvoices = await invoiceRepo.findByKyThangNam("", "", ""); // all
  const invoiceMap = new Map(allInvoices.map((i) => [i.ID_HDON, i]));
  console.info(`[parse-pdfs] Tìm thấy ${invoiceMap.size} records trong invoice_items.`);

  // 3. Xác định file cần parse
  let files = allPdfFiles;
  if (!FORCE_REPARSE) {
    const allIds = allPdfFiles.map((f) => extractInvoiceId(f)).filter((id): id is number => id !== null);
    const pendingIds = await billRepo.findPendingParse(allIds);
    files = allPdfFiles.filter((f) => {
      const id = extractInvoiceId(f);
      return id !== null && pendingIds.has(id);
    });
    console.info(`[parse-pdfs] Cần parse: ${files.length} file (bỏ qua ${allPdfFiles.length - files.length} đã parse rồi).`);
  }

  // 4. Parse song song với concurrency giới hạn
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (filePath) => {
        const invoiceId = extractInvoiceId(filePath);
        if (!invoiceId) {
          console.warn(`[parse-pdfs] Không lấy được invoiceId từ filename: ${filePath}`);
          skipped++;
          return;
        }

        const item = invoiceMap.get(invoiceId);
        if (!item) {
          console.warn(`[parse-pdfs] invoiceId=${invoiceId} không có trong invoice_items — bỏ qua.`);
          skipped++;
          return;
        }

        const result = await parseElectricityBillPdf(filePath, invoiceId, item.MA_KHANG, item.MA_DVIQLY, {
          maSogcs: item.MA_SOGCS,
          kyHieu: item.KIHIEU_SERY,
          soSery: item.SO_SERY,
          ngayPhatHanh: new Date(item.NGAY_PHANH),
        });

        if (result.success && result.bill) {
          await billRepo.upsert(result.bill);
          console.info(`[parse-pdfs] ✓ invoiceId=${invoiceId} ${item.MA_KHANG} — hạn TT: ${formatDate(result.bill.hanThanhToan)}`);
          success++;
        } else {
          await billRepo.markError(invoiceId, filePath, result.error ?? "unknown");
          console.warn(`[parse-pdfs] ✗ invoiceId=${invoiceId}: ${result.error}`);
          failed++;
        }
      }),
    );
  }

  console.info(
    `\n[parse-pdfs] Hoàn thành: ${success} thành công | ${failed} lỗi | ${skipped} bỏ qua / ${files.length} xử lý.`,
  );

  await closeMongo();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function collectPdfFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await collectPdfFiles(full)));
      } else if (entry.name.endsWith(".pdf")) {
        results.push(full);
      }
    }
  } catch {
    // thư mục không tồn tại
  }
  return results;
}

/**
 * Trích invoiceId (ID_HDON) từ tên file.
 * Format: {orgCode}_{customerCode}_{invoiceId}_{fileType}.pdf
 * Ví dụ: pc03hh_pc03hh0838723_1591526460_tbao.pdf → 1591526460
 */
function extractInvoiceId(filePath: string): number | null {
  const name = path.basename(filePath, ".pdf");
  const parts = name.split("_");
  // ID_HDON nằm ở vị trí áp chót (parts.length - 2)
  const idStr = parts.at(-2);
  if (!idStr) return null;
  const id = parseInt(idStr, 10);
  return isNaN(id) ? null : id;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("vi-VN");
}

main().catch((err) => {
  console.error("[parse-pdfs] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
