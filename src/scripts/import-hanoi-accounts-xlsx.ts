/**
 * Import danh sách tài khoản EVN Hà Nội từ file Excel.
 * Trùng username → bỏ qua (skip), không ghi đè.
 *
 * File xlsx: cột A=username, B=password, C=label (tùy chọn).
 * Dòng đầu có thể là tiêu đề — tự động phát hiện và bỏ qua.
 * Trùng cặp (username + password) — tự động lọc, giữ dòng xuất hiện trước (xem readHanoiAccountsFromXlsx).
 *
 * Usage:
 *   npm run import:hanoi-accounts:xlsx
 *   npm run import:hanoi-accounts:xlsx -- ./data/hanoi-custom.xlsx
 *
 * Cần: HANOI_CREDENTIALS_SECRET và MONGODB_URI trong .env
 */
import "dotenv/config";
import { readHanoiAccountsFromXlsx } from "../services/hanoi/hanoiAccountsXlsxImport.js";
import { HanoiAccountRepository } from "../db/hanoiAccountRepository.js";
import { env } from "../config/env.js";

async function main(): Promise<void> {
  const filePath = process.argv[2] ?? env.hanoiAccountsXlsxPath;

  console.info(`[import-hanoi-xlsx] Đọc file: ${filePath}`);

  if (!env.hanoiCredentialsSecret.trim()) {
    console.error("[import-hanoi-xlsx] Lỗi: HANOI_CREDENTIALS_SECRET chưa được cấu hình trong .env");
    process.exit(1);
  }

  const rows = await readHanoiAccountsFromXlsx(filePath);
  console.info(
    `[import-hanoi-xlsx] Sau lọc trùng (username+password): ${rows.length} tài khoản duy nhất (đã ghi log chi tiết nếu có bỏ dòng trùng).`,
  );

  if (rows.length === 0) {
    console.info("[import-hanoi-xlsx] Không có dòng nào để import.");
    process.exit(0);
  }

  const repo = new HanoiAccountRepository();
  const result = await repo.insertManyAccounts(rows);

  console.info(`[import-hanoi-xlsx] Hoàn tất:`);
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
  console.error("[import-hanoi-xlsx] Lỗi không xử lý được:", err instanceof Error ? err.message : err);
  process.exit(1);
});
