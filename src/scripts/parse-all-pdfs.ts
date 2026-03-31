/**
 * Scan toàn bộ thư mục output/pdfs, parse từng file PDF và lưu vào MongoDB.
 *
 * - CPC: `output/pdfs/{org}/..._{invoiceId}_tbao.pdf` + metadata từ invoice_items.
 * - NPC: `.../npc/{maKh}_{...}_ky{n}_{id_hdon}.pdf` (thông báo) hoặc `..._id_hdon_tt.pdf` (hóa đơn thanh toán).
 *
 * Usage:
 *   node --import tsx src/scripts/parse-all-pdfs.ts
 *   node --import tsx src/scripts/parse-all-pdfs.ts --force   (re-parse tất cả)
 *   node --import tsx src/scripts/parse-all-pdfs.ts --force --npc-only   (chỉ thư mục npc)
 */

import "dotenv/config";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { InvoiceItemRepository } from "../db/invoiceItemRepository.js";
import { ElectricityBillRepository } from "../db/electricityBillRepository.js";
import { parseElectricityBillPdf, PARSER_VERSION } from "../services/pdf/ElectricityBillParser.js";
import { npcInvoiceIdSurrogateFromIdHdon } from "../services/npc/npcElectricityBillId.js";
import { isNpcPdfPath, npcBillKeyFromParsedFilename, parseNpcPdfFilename } from "../services/npc/npcPdfFilename.js";
import { env } from "../config/env.js";

const FORCE_REPARSE = process.argv.includes("--force");
/** Chỉ quét & parse thư mục `output/pdfs/npc` — không đụng CPC */
const NPC_ONLY = process.argv.includes("--npc-only");
const CONCURRENCY = 4; // parse N files song song

async function main(): Promise<void> {
  await getMongoDb();
  const invoiceRepo = new InvoiceItemRepository();
  const billRepo = new ElectricityBillRepository();

  console.info(
    `[parse-pdfs] Bắt đầu — force=${FORCE_REPARSE}, npcOnly=${NPC_ONLY}, parserVersion=${PARSER_VERSION}`,
  );
  const pdfRoot = NPC_ONLY ? path.join(env.pdfOutputDir, "npc") : env.pdfOutputDir;
  console.info(`[parse-pdfs] Thư mục PDF: ${path.resolve(pdfRoot)}`);

  const allPdfFiles = await collectPdfFiles(pdfRoot);
  console.info(`[parse-pdfs] Tìm thấy ${allPdfFiles.length} file PDF.`);

  if (allPdfFiles.length === 0) {
    console.warn("[parse-pdfs] Không có file PDF nào để xử lý.");
    await closeMongo();
    return;
  }

  const npcFiles = NPC_ONLY ? allPdfFiles : allPdfFiles.filter(isNpcPdfPath);
  const cpcFiles = NPC_ONLY ? [] : allPdfFiles.filter((f) => !isNpcPdfPath(f));

  const allInvoices = await invoiceRepo.findByKyThangNam("", "", "");
  const invoiceMap = new Map(allInvoices.map((i) => [i.ID_HDON, i]));
  console.info(`[parse-pdfs] invoice_items: ${invoiceMap.size} bản ghi (metadata CPC).`);

  let cpcToProcess = cpcFiles;
  if (!FORCE_REPARSE && cpcFiles.length > 0) {
    const allIds = cpcFiles.map((f) => extractInvoiceId(f)).filter((id): id is number => id !== null);
    const pendingIds = await billRepo.findPendingParse(allIds);
    cpcToProcess = cpcFiles.filter((f) => {
      const id = extractInvoiceId(f);
      return id !== null && pendingIds.has(id);
    });
    console.info(
      `[parse-pdfs] CPC cần parse: ${cpcToProcess.length}/${cpcFiles.length} (đã có bản parsed cùng version).`,
    );
  }

  let npcToProcess = npcFiles;
  if (!FORCE_REPARSE && npcFiles.length > 0) {
    npcToProcess = [];
    for (const f of npcFiles) {
      const meta = parseNpcPdfFilename(f);
      if (!meta) {
        npcToProcess.push(f);
        continue;
      }
      const billKey = npcBillKeyFromParsedFilename(meta);
      const doc = await billRepo.findByBillKey(billKey);
      if (!doc || doc.status !== "parsed" || doc.parseVersion !== PARSER_VERSION) {
        npcToProcess.push(f);
      }
    }
    console.info(
      `[parse-pdfs] NPC cần parse: ${npcToProcess.length}/${npcFiles.length} (đã có bản parsed cùng version).`,
    );
  }

  const files = [...cpcToProcess, ...npcToProcess];

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (filePath) => {
        if (isNpcPdfPath(filePath)) {
          const meta = parseNpcPdfFilename(filePath);
          if (!meta) {
            console.warn(`[parse-pdfs] Tên file NPC không khớp pattern: ${filePath}`);
            skipped++;
            return;
          }
          const invSurrogate = npcInvoiceIdSurrogateFromIdHdon(meta.idHdon, meta.kind);
          const kyNum = parseInt(meta.ky, 10);
          const kyTrongKy = (kyNum >= 1 && kyNum <= 3 ? kyNum : 1) as 1 | 2 | 3;
          const result = await parseElectricityBillPdf(
            filePath,
            invSurrogate,
            meta.maKh.toUpperCase(),
            "NPC",
            {
              maSogcs: "",
              kyHieu: "",
              soSery: "",
              ngayPhatHanh: new Date(),
            },
            { npc: { npcIdHdon: meta.idHdon, kyTrongKy, npcPdfKind: meta.kind } },
          );
          if (result.success && result.bill) {
            await billRepo.upsert(result.bill);
            console.info(`[parse-pdfs] ✓ NPC id_hdon=${meta.idHdon.slice(0, 16)}… — hạn TT: ${formatDate(result.bill.hanThanhToan)}`);
            success++;
          } else {
            await billRepo.markNpcError(
              meta.idHdon,
              invSurrogate,
              filePath,
              result.error ?? "unknown",
              meta.kind,
            );
            console.warn(`[parse-pdfs] ✗ NPC ${meta.idHdon.slice(0, 12)}…: ${result.error}`);
            failed++;
          }
          return;
        }

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
 * Trích invoiceId (ID_HDON) từ tên file CPC.
 * Format: {orgCode}_{customerCode}_{invoiceId}_{fileType}.pdf
 */
function extractInvoiceId(filePath: string): number | null {
  const name = path.basename(filePath, ".pdf");
  const parts = name.split("_");
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
