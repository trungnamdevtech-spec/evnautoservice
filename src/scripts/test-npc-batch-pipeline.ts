/**
 * Chạy thử pipeline NPC đầy đủ (đăng nhập → TraCuu → XemChiTiet → PDF → parse DB)
 * trên nhiều tài khoản, chia thành các lô (batch) tuần tự.
 *
 * Mặc định: 20 user, 2 lô × 10 (có thể đổi).
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
  }
  return { ky, month, year, total, batchSize, batchDelayMs, skip };
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

async function main(): Promise<void> {
  const { ky, month, year, total, batchSize, batchDelayMs, skip } = parseArgs();

  await getMongoDb();
  const npcRepo = new NpcAccountRepository();
  const all = await npcRepo.listEnabled(0, 5000);
  const slice = all.slice(skip, skip + total);

  console.info(
    `[npc-batch] Tham số: Kỳ ${ky} — tháng ${month} — năm ${year} | cần ${total} TK (skip=${skip}, batch=${batchSize}, delay=${batchDelayMs}ms)`,
  );
  console.info(`[npc-batch] Trong DB: ${all.length} tài khoản enabled; lấy ${slice.length} bản ghi.`);

  if (slice.length === 0) {
    console.error("[npc-batch] Không đủ tài khoản enabled — kiểm tra npc_accounts hoặc giảm --skip/--total.");
    await closeMongo();
    process.exit(1);
  }

  const worker = new EVNNPCWorker(new AnticaptchaClient());

  let success = 0;
  let failed = 0;
  let batchIndex = 0;

  for (let i = 0; i < slice.length; i += batchSize) {
    batchIndex++;
    const batch = slice.slice(i, i + batchSize);
    console.info(`\n[npc-batch] ===== Lô ${batchIndex}: ${batch.length} tài khoản (${slice[i]?.username} …) =====\n`);

    for (let j = 0; j < batch.length; j++) {
      const acc = batch[j]!;
      const globalIdx = skip + i + j + 1;
      const traceId = `npc-batch-${batchIndex}-${j + 1}-${acc.username}`;
      console.info(`[npc-batch] [${globalIdx}/${skip + slice.length}] ${acc.username} …`);

      const result = await runOneAccountPipeline(worker, acc, ky, month, year, traceId);

      if (result.ok) {
        success++;
        const m = result.metadata;
        const pdf = m.pdfSync;
        const parse = m.parseSync;
        console.info(
          `[npc-batch]   ✓ OK — pdf ${pdf?.success ?? 0}/${pdf?.attempted ?? 0} | parse ${parse?.success ?? 0}/${parse?.attempted ?? 0}`,
        );
      } else {
        failed++;
        console.warn(`[npc-batch]   ✗ ${result.error.slice(0, 400)}`);
      }
    }

    if (i + batchSize < slice.length && batchDelayMs > 0) {
      console.info(`[npc-batch] Nghỉ ${batchDelayMs}ms trước lô tiếp theo…`);
      await sleep(batchDelayMs);
    }
  }

  await closeMongo();

  console.info(`\n[npc-batch] Hoàn tất: thành công ${success} / thất bại ${failed} / tổng ${slice.length}`);
}

main().catch((err) => {
  console.error("[npc-batch]", err instanceof Error ? err.message : err);
  process.exit(1);
});
