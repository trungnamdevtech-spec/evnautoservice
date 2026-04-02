/**
 * Xóa toàn bộ hanoi_accounts rồi nạp lại từ file Excel.
 * THAO TÁC KHÔNG THỂ HOÀN TÁC — xóa sạch session đã lưu.
 *
 * File xlsx: cột A=username, B=password, C=label (tùy chọn).
 * Trùng (username+password) được lọc trước khi nạp (giữ dòng đầu).
 *
 * Usage:
 *   npm run replace:hanoi-accounts:xlsx
 *   npm run replace:hanoi-accounts:xlsx -- ./data/hanoi-accounts.xlsx --confirm-delete-all
 *   npm run replace:hanoi-accounts:xlsx -- ./data/hanoi-accounts.xlsx --confirm-delete-all --wipe-hanoi-tasks
 *
 * Cần: HANOI_CREDENTIALS_SECRET và MONGODB_URI trong .env
 */
import "dotenv/config";
import { readHanoiAccountsFromXlsx } from "../services/hanoi/hanoiAccountsXlsxImport.js";
import { HanoiAccountRepository } from "../db/hanoiAccountRepository.js";
import { TaskRepository } from "../db/taskRepository.js";
import { env } from "../config/env.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filePath = args.find((a) => !a.startsWith("--")) ?? env.hanoiAccountsXlsxPath;
  const confirmed = args.includes("--confirm-delete-all");
  const wipeTasks = args.includes("--wipe-hanoi-tasks");

  if (!confirmed) {
    console.error(
      "[replace-hanoi-xlsx] DỪNG LẠI: Thao tác này xóa TOÀN BỘ hanoi_accounts.\n" +
        "  Thêm flag --confirm-delete-all để xác nhận.\n" +
        "  Ví dụ: npm run replace:hanoi-accounts:xlsx -- ./data/hanoi-accounts.xlsx --confirm-delete-all",
    );
    process.exit(1);
  }

  if (!env.hanoiCredentialsSecret.trim()) {
    console.error("[replace-hanoi-xlsx] Lỗi: HANOI_CREDENTIALS_SECRET chưa được cấu hình trong .env");
    process.exit(1);
  }

  console.info(`[replace-hanoi-xlsx] Đọc file: ${filePath}`);
  const rows = await readHanoiAccountsFromXlsx(filePath);
  console.info(`[replace-hanoi-xlsx] Sau lọc trùng: ${rows.length} tài khoản duy nhất`);

  if (rows.length === 0) {
    console.error("[replace-hanoi-xlsx] File rỗng hoặc không có dòng hợp lệ — hủy để tránh xóa DB.");
    process.exit(1);
  }

  const repo = new HanoiAccountRepository();
  const taskRepo = new TaskRepository();

  if (wipeTasks) {
    console.warn("[replace-hanoi-xlsx] --wipe-hanoi-tasks: xóa mọi task EVN_HANOI...");
    const deleted = await taskRepo.deleteAllByProvider("EVN_HANOI");
    console.info(`[replace-hanoi-xlsx] Đã xóa ${deleted} task EVN_HANOI.`);
  }

  console.warn("[replace-hanoi-xlsx] Xóa toàn bộ hanoi_accounts...");
  const deleted = await repo.deleteAll();
  console.info(`[replace-hanoi-xlsx] Đã xóa ${deleted} tài khoản cũ.`);

  const result = await repo.insertManyAccounts(rows);

  console.info("[replace-hanoi-xlsx] Hoàn tất nạp lại:");
  console.info(`  - Đã thêm: ${result.inserted}`);
  console.info(`  - Bỏ qua (trùng username): ${result.skipped}`);
  if (result.errors.length > 0) {
    console.warn(`  - Lỗi (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 20)) {
      console.warn(`    • ${e}`);
    }
  }
}

main().catch((err) => {
  console.error("[replace-hanoi-xlsx] Lỗi không xử lý được:", err instanceof Error ? err.message : err);
  process.exit(1);
});
