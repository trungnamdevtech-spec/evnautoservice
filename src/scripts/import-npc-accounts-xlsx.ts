/**
 * Import tài khoản NPC từ file Excel (.xlsx) vào MongoDB.
 *
 * - Sheet đầu tiên (hoặc --sheet=TênSheet).
 * - Cột A: username, cột B: password (không bắt buộc dòng tiêu đề — nếu dòng 1 trông giống header sẽ bỏ qua nhẹ).
 *
 * Yêu cầu: MONGODB_URI, NPC_CREDENTIALS_SECRET trong .env
 *
 * Usage:
 *   npm run import:npc-accounts:xlsx -- path/to/accounts.xlsx
 *   npm run import:npc-accounts:xlsx -- path/to/accounts.xlsx --sheet=Sheet1
 *
 * Hoặc đặt file `data/npc-accounts.xlsx` và bật AUTO_IMPORT_NPC_XLSX=true khi khởi động app (xem .env.example).
 *
 * **Thay thế toàn bộ** (xóa hết user cũ rồi nạp file mới): `npm run replace:npc-accounts:xlsx -- <file.xlsx> --confirm-delete-all`
 */

import "dotenv/config";
import path from "node:path";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { NpcAccountRepository } from "../db/npcAccountRepository.js";
import { importNpcAccountsFromXlsxFile } from "../services/npc/npcAccountsXlsxImport.js";

function parseArgs(): { file: string; sheet?: string } {
  const rest = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const file = rest[0];
  const sheetArg = process.argv.find((a) => a.startsWith("--sheet="));
  const sheet = sheetArg ? sheetArg.slice("--sheet=".length).trim() : undefined;
  return { file: file ?? "", sheet: sheet || undefined };
}

async function main(): Promise<void> {
  const { file, sheet: sheetName } = parseArgs();
  if (!file) {
    console.error("Usage: npm run import:npc-accounts:xlsx -- <file.xlsx> [--sheet=Sheet1]");
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), file);

  await getMongoDb();
  const repo = new NpcAccountRepository();
  const result = await importNpcAccountsFromXlsxFile(repo, abs, sheetName);
  await closeMongo();

  const p = result.parse;
  if (p.rows.length === 0) {
    console.error(
      `[import-npc-xlsx] Không có dòng dữ liệu hợp lệ (đã đọc ${p.lastRowNumber} dòng, empty=${p.skippedEmpty}, noUser=${p.skippedNoUser}, noPass=${p.skippedNoPass}).`,
    );
    process.exit(1);
  }

  console.info(
    `[import-npc-xlsx] Sheet: "${p.sheetName}" — inserted=${result.inserted} skipped(duplicate)=${result.skipped} validRows=${p.rows.length}`,
  );
  console.info(
    `[import-npc-xlsx] Thống kê bỏ qua: hàng trống=${p.skippedEmpty} thiếu username=${p.skippedNoUser} thiếu password=${p.skippedNoPass} header=${p.skippedHeader}`,
  );
  if (result.errors.length > 0) {
    console.warn("[import-npc-xlsx] Lỗi insert:", result.errors.slice(0, 30));
  }
}

main().catch((err) => {
  console.error("[import-npc-xlsx]", err instanceof Error ? err.message : err);
  process.exit(1);
});
