/**
 * Xóa toàn bộ `npc_accounts` rồi nạp lại từ file Excel (.xlsx).
 *
 * - Đọc & kiểm tra dữ liệu **trước** — chỉ khi có ít nhất một dòng hợp lệ mới xóa DB.
 * - Cột A: username, cột B: password (giống import:npc-accounts:xlsx).
 *
 * Bắt buộc cờ xác nhận để tránh chạy nhầm:
 *   --confirm-delete-all
 *
 * Tuỳ chọn (khuyến nghị khi thay toàn bộ user trên server):
 *   --wipe-npc-tasks  — xóa hết `scrape_tasks` có provider EVN_NPC (tránh task cũ trỏ id cũ).
 *
 * Usage:
 *   npm run replace:npc-accounts:clean
 *   npm run replace:npc-accounts:xlsx -- path/to/accounts.xlsx --confirm-delete-all
 *   npm run replace:npc-accounts:xlsx -- data/account_clean.xlsx --confirm-delete-all --wipe-npc-tasks --sheet=Sheet1
 *
 * Yêu cầu: MONGODB_URI, NPC_CREDENTIALS_SECRET trong .env
 */

import "dotenv/config";
import path from "node:path";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { NpcAccountRepository } from "../db/npcAccountRepository.js";
import { TaskRepository } from "../db/taskRepository.js";
import { replaceAllNpcAccountsFromXlsxFile } from "../services/npc/npcAccountsXlsxImport.js";

function parseArgs(): { file: string; sheet?: string; confirmed: boolean; wipeNpcTasks: boolean } {
  const rest = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const file = rest[0] ?? "";
  const sheetArg = process.argv.find((a) => a.startsWith("--sheet="));
  const sheet = sheetArg ? sheetArg.slice("--sheet=".length).trim() : undefined;
  const confirmed = process.argv.includes("--confirm-delete-all");
  const wipeNpcTasks = process.argv.includes("--wipe-npc-tasks");
  return { file, sheet: sheet || undefined, confirmed, wipeNpcTasks };
}

async function main(): Promise<void> {
  const { file, sheet: sheetName, confirmed, wipeNpcTasks } = parseArgs();
  if (!file) {
    console.error(
      "Usage: npm run replace:npc-accounts:xlsx -- <file.xlsx> --confirm-delete-all [--wipe-npc-tasks] [--sheet=Sheet1]",
    );
    process.exit(1);
  }
  if (!confirmed) {
    console.error(
      "[replace-npc-xlsx] Thiếu --confirm-delete-all — thao tác này XÓA HẾT npc_accounts. Thêm cờ để chạy.",
    );
    process.exit(1);
  }

  const abs = path.resolve(process.cwd(), file);

  await getMongoDb();
  const repo = new NpcAccountRepository();
  const taskRepo = new TaskRepository();

  const result = await replaceAllNpcAccountsFromXlsxFile(repo, abs, sheetName, {
    wipeNpcTasks,
    taskRepo: wipeNpcTasks ? taskRepo : undefined,
  });
  await closeMongo();

  const p = result.parse;
  if (result.npcTasksDeleted != null) {
    console.info(`[replace-npc-xlsx] Đã xóa ${result.npcTasksDeleted} scrape_tasks (provider=EVN_NPC).`);
  }
  console.info(
    `[replace-npc-xlsx] Đã xóa ${result.deleted} bản ghi npc_accounts cũ — inserted=${result.inserted} skipped(duplicate)=${result.skipped} validRows=${p.rows.length}`,
  );
  console.info(`[replace-npc-xlsx] Sheet: "${p.sheetName}"`);
  console.info(
    `[replace-npc-xlsx] Thống kê parse: empty=${p.skippedEmpty} noUser=${p.skippedNoUser} noPass=${p.skippedNoPass} header=${p.skippedHeader}`,
  );
  if (result.errors.length > 0) {
    console.warn("[replace-npc-xlsx] Lỗi insert:", result.errors.slice(0, 30));
  }
}

main().catch((err) => {
  console.error("[replace-npc-xlsx]", err instanceof Error ? err.message : err);
  process.exit(1);
});
