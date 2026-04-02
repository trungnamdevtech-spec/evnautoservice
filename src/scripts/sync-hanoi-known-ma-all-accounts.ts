/**
 * Đồng bộ userinfo + danh sách hợp đồng cho mọi tài khoản Hanoi trong DB,
 * để gộp `knownMaKhachHang` (mã KH → account) phục vụ tra cứu agent.
 *
 * Usage:
 *   npm run sync:hanoi-known-ma
 *   npm run sync:hanoi-known-ma -- --dry-run
 *   npm run sync:hanoi-known-ma -- --all-in-db --concurrency=1 --delay-ms=1000
 *
 * Env: HANOI_CREDENTIALS_SECRET, cấu hình STS/API như worker.
 * Logic dùng chung với POST /api/hanoi/sync-known-ma (HANOI_SYNC_KNOWN_MA_API_ENABLED).
 */
import "dotenv/config";
import { env } from "../config/env.js";
import { HanoiAccountRepository } from "../db/hanoiAccountRepository.js";
import { HanoiContractRepository } from "../db/hanoiContractRepository.js";
import {
  loadHanoiAccountsForSync,
  runHanoiSyncKnownMaBatch,
} from "../services/hanoi/hanoiSyncKnownMaBatch.js";

function parseArgs(argv: string[]): {
  dryRun: boolean;
  allInDb: boolean;
  forceRefresh: boolean;
  concurrency: number;
  delayMs: number;
} {
  let dryRun = false;
  let allInDb = false;
  let forceRefresh = true;
  let concurrency = 2;
  let delayMs = 500;

  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--all-in-db") allInDb = true;
    else if (a === "--no-force") forceRefresh = false;
    else if (a.startsWith("--concurrency=")) {
      const n = Number.parseInt(a.slice("--concurrency=".length), 10);
      if (Number.isFinite(n) && n >= 1 && n <= 32) concurrency = n;
    } else if (a.startsWith("--delay-ms=")) {
      const n = Number.parseInt(a.slice("--delay-ms=".length), 10);
      if (Number.isFinite(n) && n >= 0 && n <= 600_000) delayMs = n;
    }
  }

  return { dryRun, allInDb, forceRefresh, concurrency, delayMs };
}

async function main(): Promise<void> {
  const { dryRun, allInDb, forceRefresh, concurrency, delayMs } = parseArgs(process.argv.slice(2));
  const secret = env.hanoiCredentialsSecret.trim();
  if (!secret) {
    console.error("[sync-hanoi-known-ma] Thiếu HANOI_CREDENTIALS_SECRET");
    process.exit(1);
  }

  const hanoiRepo = new HanoiAccountRepository();
  const contractRepo = new HanoiContractRepository();
  const accounts = await loadHanoiAccountsForSync(hanoiRepo, allInDb);

  console.info(
    `[sync-hanoi-known-ma] Tổng ${accounts.length} tài khoản (${allInDb ? "mọi bản ghi" : "enabled, không wrong_password"}) — dryRun=${dryRun} forceRefresh=${forceRefresh} concurrency=${concurrency} delayMs=${delayMs}`,
  );

  if (dryRun) {
    for (const a of accounts) {
      console.info(`  — ${a.username} (${a._id?.toHexString()}) enabled=${a.enabled}`);
    }
    process.exit(0);
  }

  const result = await runHanoiSyncKnownMaBatch(
    { allInDb, forceRefresh, concurrency, delayMs },
    { hanoiRepo, contractRepo },
  );

  console.info(
    `[sync-hanoi-known-ma] Xong — ok=${result.ok} skipped=${result.skipped} fail=${result.fail} total=${result.totalAccounts}`,
  );
  if (result.errors.length > 0) {
    const preview = result.errors.slice(0, 30);
    for (const { username, error } of preview) {
      console.info(`  FAIL ${username}: ${error.slice(0, 200)}`);
    }
    if (result.errors.length > 30) {
      console.info(`  … và ${result.errors.length - 30} lỗi khác`);
    }
  }

  process.exit(result.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
