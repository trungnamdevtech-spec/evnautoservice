/**
 * Chạy thử pipeline NPC đầy đủ (đăng nhập → TraCuu → XemChiTiet → PDF → parse DB)
 * trên nhiều tài khoản, chia thành các lô (batch) tuần tự.
 *
 * Mặc định: 20 user, 2 lô × 10 (có thể đổi).
 * Sau lượt chính: mặc định **một vòng retry** chỉ các TK lỗi do captcha (API/site hết lần thử)
 * — tránh bỏ sót do captcha khó; tắt: `--captcha-retry-rounds=0`.
 *
 * Usage (khuyến nghị — tránh npm nuốt cờ `--ky` trên npm 10+):
 *   node --import tsx src/scripts/test-npc-batch-pipeline.ts --ky=1 --month=3 --year=2026 --total=20 --batch-size=10
 *
 * Hoặc dùng biến môi trường (xem NPC_BATCH_* trong .env.example).
 *
 * Cần: MongoDB, NPC_CREDENTIALS_SECRET, ANTICAPTCHA_API_KEY, .env NPC URLs.
 */

import "dotenv/config";
import type { BrowserContext, Page } from "playwright";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { NpcAccountRepository } from "../db/npcAccountRepository.js";
import { AnticaptchaClient } from "../services/captcha/AnticaptchaClient.js";
import { EVNNPCWorker } from "../providers/npc/EVNNPCWorker.js";
import { normalizeStorageState } from "../core/BaseWorker.js";
import type { InvoiceDownloadMetadata, ScrapeTask } from "../types/task.js";
import type { NpcAccount } from "../types/npcAccount.js";
import { env } from "../config/env.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseArgs(): {
  ky: string;
  month: string;
  year: string;
  total: number;
  batchSize: number;
  batchDelayMs: number;
  skip: number;
  captchaRetryRounds: number;
  captchaRetryDelayMs: number;
} {
  const ev = process.env;
  let ky = ev.NPC_BATCH_KY?.trim() || "1";
  let month = ev.NPC_BATCH_MONTH?.trim()
    ? pad2(Number.parseInt(ev.NPC_BATCH_MONTH, 10) || 1)
    : pad2(new Date().getMonth() + 1);
  let year = ev.NPC_BATCH_YEAR?.trim() || String(new Date().getFullYear());
  let total = ev.NPC_BATCH_TOTAL ? Number.parseInt(ev.NPC_BATCH_TOTAL, 10) || 20 : 20;
  let batchSize = ev.NPC_BATCH_SIZE ? Number.parseInt(ev.NPC_BATCH_SIZE, 10) || 10 : 10;
  let batchDelayMs = ev.NPC_BATCH_DELAY_MS ? Number.parseInt(ev.NPC_BATCH_DELAY_MS, 10) || 4000 : 4000;
  let skip = ev.NPC_BATCH_SKIP ? Number.parseInt(ev.NPC_BATCH_SKIP, 10) || 0 : 0;
  /** Số vòng retry sau lượt chính (chỉ TK lỗi captcha). 0 = tắt. Mặc định 1. */
  let captchaRetryRounds = ev.NPC_BATCH_CAPTCHA_RETRY_ROUNDS
    ? Number.parseInt(ev.NPC_BATCH_CAPTCHA_RETRY_ROUNDS, 10)
    : 1;
  if (!Number.isFinite(captchaRetryRounds)) captchaRetryRounds = 1;
  captchaRetryRounds = Math.max(0, Math.min(20, captchaRetryRounds));
  let captchaRetryDelayMs = ev.NPC_BATCH_CAPTCHA_RETRY_DELAY_MS
    ? Number.parseInt(ev.NPC_BATCH_CAPTCHA_RETRY_DELAY_MS, 10) || 3000
    : 3000;
  if (!Number.isFinite(captchaRetryDelayMs)) captchaRetryDelayMs = 3000;
  captchaRetryDelayMs = Math.max(0, captchaRetryDelayMs);

  total = Math.max(1, total);
  batchSize = Math.max(1, batchSize);
  batchDelayMs = Math.max(0, batchDelayMs);
  skip = Math.max(0, skip);

  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--ky=")) ky = a.slice(5);
    else if (a.startsWith("--month=")) {
      month = pad2(Number.parseInt(a.slice(8), 10) || 1);
    } else if (a.startsWith("--thang=")) {
      month = pad2(Number.parseInt(a.slice(8), 10) || 1);
    } else if (a.startsWith("--year=") || a.startsWith("--nam=")) {
      year = a.includes("--year=") ? a.slice(7) : a.slice(6);
    } else if (a.startsWith("--total=")) total = Math.max(1, Number.parseInt(a.slice(8), 10) || 20);
    else if (a.startsWith("--batch-size=")) batchSize = Math.max(1, Number.parseInt(a.slice(13), 10) || 10);
    else if (a.startsWith("--batch-delay-ms="))
      batchDelayMs = Math.max(0, Number.parseInt(a.slice(17), 10) || 4000);
    else if (a.startsWith("--skip=")) skip = Math.max(0, Number.parseInt(a.slice(7), 10) || 0);
    else if (a.startsWith("--captcha-retry-rounds="))
      captchaRetryRounds = Math.max(0, Math.min(20, Number.parseInt(a.slice(23), 10) || 0));
    else if (a.startsWith("--captcha-retry-delay-ms="))
      captchaRetryDelayMs = Math.max(0, Number.parseInt(a.slice(25), 10) || 0);
  }
  return { ky, month, year, total, batchSize, batchDelayMs, skip, captchaRetryRounds, captchaRetryDelayMs };
}

/**
 * Lỗi có thể do captcha khó / API anticaptcha / chụp ảnh — đưa vào hàng retry cuối phiên.
 * Không retry sai mật khẩu (đã tắt TK).
 */
function isCaptchaRetryableFailure(message: string): boolean {
  if (/wrong_password|sai mật khẩu|đã tắt tài khoản|disabledReason/i.test(message)) return false;
  if (/Captcha sai sau \d+ lần/i.test(message)) return true;
  if (message.includes("AnticaptchaClient:")) return true;
  if (message.includes("Không lấy được vùng captcha")) return true;
  return false;
}

async function runOneAccountPipeline(
  worker: EVNNPCWorker,
  account: NpcAccount,
  ky: string,
  month: string,
  year: string,
  traceTaskId: string,
): Promise<{ ok: true; metadata: InvoiceDownloadMetadata } | { ok: false; error: string }> {
  const task: ScrapeTask = {
    status: "RUNNING",
    provider: "EVN_NPC",
    payload: {
      npcAccountId: account._id!.toHexString(),
      period: ky,
      month,
      year,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let browserSessionStarted = false;

  try {
    await worker.beginBrowserSession();
    browserSessionStarted = true;
    const storage = normalizeStorageState(account.storageStateJson ?? undefined);
    context = await worker.createDisposableContext(storage);
    page = await context.newPage();
    const metadata = await worker.runTask(page, task, traceTaskId);
    return { ok: true, metadata };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  } finally {
    if (page && env.playwrightPauseBeforeCloseMs > 0) {
      await new Promise((r) => setTimeout(r, env.playwrightPauseBeforeCloseMs));
    }
    if (page) await page.close().catch(() => undefined);
    if (context) await context.close().catch(() => undefined);
    if (browserSessionStarted) await worker.endBrowserSession();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RunSliceResult {
  success: number;
  failedOther: number;
  captchaRetry: NpcAccount[];
}

/** Chạy tuần tự danh sách TK (chia lô giống lượt chính). */
async function runAccountSlice(
  worker: EVNNPCWorker,
  accounts: NpcAccount[],
  ky: string,
  month: string,
  year: string,
  batchSize: number,
  batchDelayMs: number,
  /** Chỉ số bắt đầu cho log tiến độ (lượt chính = skip; retry = 0). */
  progressStart: number,
  /** Tổng mẫu số log (lượt chính = độ dài slice; retry = số TK trong hàng đợi). */
  progressTotal: number,
  tracePrefix: string,
  phaseTag: string,
): Promise<RunSliceResult> {
  let success = 0;
  let failedOther = 0;
  const captchaRetry: NpcAccount[] = [];
  let batchIndex = 0;

  for (let i = 0; i < accounts.length; i += batchSize) {
    batchIndex++;
    const batch = accounts.slice(i, i + batchSize);
    console.info(
      `\n[${phaseTag}] ===== Lô ${batchIndex}: ${batch.length} tài khoản (${batch[0]?.username} …) =====\n`,
    );

    for (let j = 0; j < batch.length; j++) {
      const acc = batch[j]!;
      const globalIdx = progressStart + i + j + 1;
      const traceId = `${tracePrefix}-${batchIndex}-${j + 1}-${acc.username}`;
      console.info(`[${phaseTag}] [${globalIdx}/${progressStart + progressTotal}] ${acc.username} …`);

      const result = await runOneAccountPipeline(worker, acc, ky, month, year, traceId);

      if (result.ok) {
        success++;
        const m = result.metadata;
        const pdf = m.pdfSync;
        const parse = m.parseSync;
        console.info(
          `[${phaseTag}]   ✓ OK — pdf ${pdf?.success ?? 0}/${pdf?.attempted ?? 0} | parse ${parse?.success ?? 0}/${parse?.attempted ?? 0}`,
        );
      } else if (isCaptchaRetryableFailure(result.error)) {
        captchaRetry.push(acc);
        console.warn(`[${phaseTag}]   ✗ (sẽ retry captcha) ${result.error.slice(0, 400)}`);
      } else {
        failedOther++;
        console.warn(`[${phaseTag}]   ✗ ${result.error.slice(0, 400)}`);
      }
    }

    if (i + batchSize < accounts.length && batchDelayMs > 0) {
      console.info(`[${phaseTag}] Nghỉ ${batchDelayMs}ms trước lô tiếp theo…`);
      await sleep(batchDelayMs);
    }
  }

  return { success, failedOther, captchaRetry };
}

async function main(): Promise<void> {
  const { ky, month, year, total, batchSize, batchDelayMs, skip, captchaRetryRounds, captchaRetryDelayMs } =
    parseArgs();

  await getMongoDb();
  const npcRepo = new NpcAccountRepository();
  const all = await npcRepo.listEnabled(0, 5000);
  const slice = all.slice(skip, skip + total);

  console.info(
    `[npc-batch] Tham số: Kỳ ${ky} — tháng ${month} — năm ${year} | cần ${total} TK (skip=${skip}, batch=${batchSize}, delay=${batchDelayMs}ms, captchaRetryRounds=${captchaRetryRounds}, captchaRetryDelayMs=${captchaRetryDelayMs}ms)`,
  );
  console.info(`[npc-batch] Trong DB: ${all.length} tài khoản enabled; lấy ${slice.length} bản ghi.`);

  if (slice.length === 0) {
    console.error("[npc-batch] Không đủ tài khoản enabled — kiểm tra npc_accounts hoặc giảm --skip/--total.");
    await closeMongo();
    process.exit(1);
  }

  const worker = new EVNNPCWorker(new AnticaptchaClient());

  const mainResult = await runAccountSlice(
    worker,
    slice,
    ky,
    month,
    year,
    batchSize,
    batchDelayMs,
    skip,
    slice.length,
    "npc-batch",
    "npc-batch",
  );

  let success = mainResult.success;
  let failedOther = mainResult.failedOther;
  let captchaQueue = mainResult.captchaRetry;
  let captchaRecovered = 0;

  for (let round = 1; round <= captchaRetryRounds && captchaQueue.length > 0; round++) {
    if (captchaRetryDelayMs > 0) {
      console.info(
        `\n[npc-batch] Chờ ${captchaRetryDelayMs}ms trước vòng retry captcha ${round}/${captchaRetryRounds} (${captchaQueue.length} TK)…`,
      );
      await sleep(captchaRetryDelayMs);
    } else {
      console.info(
        `\n[npc-batch] === Vòng retry captcha ${round}/${captchaRetryRounds} (${captchaQueue.length} TK) ===\n`,
      );
    }

    const phaseTag = `npc-batch-retry${round}`;
    const tracePrefix = `npc-batch-retry${round}`;
    const qLen = captchaQueue.length;
    const r = await runAccountSlice(
      worker,
      captchaQueue,
      ky,
      month,
      year,
      batchSize,
      batchDelayMs,
      0,
      qLen,
      tracePrefix,
      phaseTag,
    );

    captchaRecovered += r.success;
    failedOther += r.failedOther;
    success += r.success;
    captchaQueue = r.captchaRetry;
  }

  const failedCaptchaFinal = captchaQueue.length;
  const failedTotal = failedOther + failedCaptchaFinal;

  await closeMongo();

  console.info(
    `\n[npc-batch] Hoàn tất: OK ${success} / lỗi khác (không retry captcha) ${failedOther} / vẫn lỗi captcha sau ${captchaRetryRounds} vòng retry ${failedCaptchaFinal} / tổng TK trong lượt ${slice.length}`,
  );
  if (captchaRetryRounds > 0 && captchaRecovered > 0) {
    console.info(`[npc-batch] Đã cứu được sau retry captcha: ${captchaRecovered} TK.`);
  }
}

main().catch((err) => {
  console.error("[npc-batch]", err instanceof Error ? err.message : err);
  process.exit(1);
});
