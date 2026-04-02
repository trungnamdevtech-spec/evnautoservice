/**
 * Chạy **một job Hanoi thật** end-to-end: tạo task PENDING → claim → `processHanoiTask`
 * (STS / Playwright theo env → GetThongTin → XemHoaDon → parse → `electricity_bills`).
 *
 * Không phải mock — dùng tài khoản **enabled** trong MongoDB (`hanoi_accounts`).
 *
 * Usage:
 *   npm run run:hanoi-once
 *
 * Tuỳ chọn (PowerShell):
 *   $env:HANOI_RUN_ACCOUNT_ID='<ObjectId hex>'   # mặc định: account enabled đầu tiên
 *   $env:HANOI_RUN_MONTH='02'; $env:HANOI_RUN_YEAR='2026'; $env:HANOI_RUN_PERIOD='1'
 */
import "dotenv/config";
import { ObjectId } from "mongodb";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { TaskRepository } from "../db/taskRepository.js";
import { HanoiAccountRepository } from "../db/hanoiAccountRepository.js";
import { AnticaptchaClient } from "../services/captcha/AnticaptchaClient.js";
import { EVNHanoiWorker } from "../providers/hanoi/EVNHanoiWorker.js";
import { processHanoiTask, createWorkerId } from "../worker/processTask.js";

async function main(): Promise<void> {
  await getMongoDb();
  const repo = new TaskRepository();
  const hanoiRepo = new HanoiAccountRepository();
  const captcha = new AnticaptchaClient();
  const hanoiWorker = new EVNHanoiWorker(captcha);
  const wid = createWorkerId();

  const accountHex = (process.env.HANOI_RUN_ACCOUNT_ID ?? "").trim();
  let accountId: ObjectId;
  if (accountHex) {
    accountId = new ObjectId(accountHex);
    const acc = await hanoiRepo.findById(accountId);
    if (!acc) {
      throw new Error(`Không có hanoi_accounts _id=${accountHex}`);
    }
    console.info(`[run-hanoi] Tài khoản (theo HANOI_RUN_ACCOUNT_ID): ${acc.username}`);
  } else {
    const acc = (await hanoiRepo.listEnabled(0, 1))[0];
    if (!acc?._id) {
      throw new Error("Không có hanoi_accounts enabled — thêm TK hoặc đặt HANOI_RUN_ACCOUNT_ID.");
    }
    accountId = acc._id;
    console.info(`[run-hanoi] Tài khoản (enabled đầu tiên trong DB): ${acc.username} (${accountId.toHexString()})`);
  }

  const month = (process.env.HANOI_RUN_MONTH ?? "02").trim().padStart(2, "0");
  const yearRaw = (process.env.HANOI_RUN_YEAR ?? "2026").trim();
  const yearNum = Number.parseInt(yearRaw, 10);
  const year = Number.isFinite(yearNum) ? yearNum : 2026;
  const period = (process.env.HANOI_RUN_PERIOD ?? "1").trim() || "1";

  const payload = {
    hanoiAccountId: accountId.toHexString(),
    period,
    month,
    year,
  };

  const taskId = await repo.insertPendingHanoi(payload);
  console.info(`[run-hanoi] Đã tạo task PENDING ${taskId.toHexString()}`, payload);

  const claimed = await repo.claimById(taskId, wid);
  if (!claimed) {
    throw new Error("Không claim được task (đã bị worker khác lấy?)");
  }

  const task = await repo.findById(taskId);
  if (!task) {
    throw new Error("Không đọc lại task sau claim");
  }

  console.info("[run-hanoi] Đang chạy processHanoiTask (pipeline production)…");
  await processHanoiTask(task, repo, hanoiWorker);

  const after = await repo.findById(taskId);
  console.info(`[run-hanoi] Trạng thái cuối: ${after?.status ?? "?"}`);
  if (after?.errorMessage) {
    console.info(`[run-hanoi] Lỗi: ${after.errorMessage.slice(0, 500)}`);
  }
  if (after?.resultMetadata?.lookupPayload && typeof after.resultMetadata.lookupPayload === "object") {
    const lp = after.resultMetadata.lookupPayload as Record<string, unknown>;
    const tc = lp.hanoiTraCuu as Record<string, unknown> | undefined;
    if (tc?.matchedCount != null) {
      console.info(`[run-hanoi] lookup: matchedCount=${tc.matchedCount} distinctKy=${JSON.stringify(tc.distinctKyInMonth)}`);
    }
  }

  await closeMongo();
  console.info("[run-hanoi] Xong — kiểm tra MongoDB: scrape_tasks + electricity_bills (provider EVN_HANOI).");
}

main().catch((e) => {
  console.error("[run-hanoi]", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
