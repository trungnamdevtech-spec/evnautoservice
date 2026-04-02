import type { BrowserContext, Page } from "playwright";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { normalizeStorageState } from "../core/BaseWorker.js";
import type { ObjectId } from "mongodb";
import type { TaskRepository } from "../db/taskRepository.js";
import type { InvoiceDownloadMetadata, ScrapeTask } from "../types/task.js";
import type { EVNCPCWorker } from "../providers/evn/EVNCPCWorker.js";
import type { EVNNPCWorker } from "../providers/npc/EVNNPCWorker.js";
import type { EVNHanoiWorker } from "../providers/hanoi/EVNHanoiWorker.js";
import { NpcAccountRepository } from "../db/npcAccountRepository.js";
import { HanoiAccountRepository } from "../db/hanoiAccountRepository.js";
import { parseNpcAccountIdFromPayload } from "../providers/npc/npcTaskPayload.js";
import { parseHanoiAccountIdFromPayload } from "../providers/hanoi/hanoiTaskPayload.js";
import { InvoiceItemRepository } from "../db/invoiceItemRepository.js";
import { ElectricityBillRepository } from "../db/electricityBillRepository.js";
import { parseElectricityBillPdf } from "../services/pdf/ElectricityBillParser.js";
import { logTaskPhase, logger } from "../core/logger.js";
import { decryptNpcPassword } from "../services/crypto/npcCredentials.js";
import { fetchNpcOnlinePaymentLink } from "../services/npc/npcOnlinePaymentLink.js";
import { normalizeNpcMaKhachHangInput } from "../services/npc/npcMaKhachHangNormalize.js";
import { fireAgentTaskWebhook } from "../services/webhook/agentTaskWebhook.js";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

const TASK_FAILED_MAX_LEN = 8000;

/**
 * Luôn dùng cặp này khi kết thúc task (tránh quên bước webhook như nhánh `online_payment_link` trước đây).
 */
async function completeTaskSuccess(
  repo: TaskRepository,
  task: ScrapeTask,
  taskId: ObjectId,
  metadata: InvoiceDownloadMetadata,
): Promise<void> {
  await repo.markSuccess(taskId, metadata);
  await fireAgentTaskWebhook({ task, taskId, status: "SUCCESS", resultMetadata: metadata });
}

async function completeTaskFailed(
  repo: TaskRepository,
  task: ScrapeTask,
  taskId: ObjectId,
  reason: string,
): Promise<void> {
  const trimmed = reason.slice(0, TASK_FAILED_MAX_LEN);
  await repo.markFailed(taskId, trimmed);
  await fireAgentTaskWebhook({
    task,
    taskId,
    status: "FAILED",
    errorMessage: trimmed,
  });
}

const invoiceRepo = new InvoiceItemRepository();
const billRepo = new ElectricityBillRepository();

/**
 * Sau khi scrape + download PDF xong, tự động parse các PDF mới tải về.
 * Chỉ parse file chưa có hoặc parseVersion cũ trong kỳ/tháng/năm đó.
 */
async function autoParseNewPdfs(
  taskHex: string,
  ky: string,
  thang: string,
  nam: string,
): Promise<{ attempted: number; success: number; failed: number }> {
  // thang từ payload dạng "03", nhưng DB lưu dạng "3"
  const thangNorm = String(Number.parseInt(thang, 10));
  const items = await invoiceRepo.findByKyThangNam(ky, thangNorm, nam);
  if (items.length === 0) return { attempted: 0, success: 0, failed: 0 };

  const invoiceIds = items.map((i) => i.ID_HDON);
  const pendingIds = await billRepo.findPendingParse(invoiceIds);

  let success = 0;
  let failed = 0;

  for (const item of items) {
    if (!pendingIds.has(item.ID_HDON)) continue;

    const pdfRecord = item.pdfDownloads?.["TBAO"];
    if (pdfRecord?.status !== "ok" || !pdfRecord.filePath) {
      // PDF chưa tải về — bỏ qua
      failed++;
      continue;
    }

    const result = await parseElectricityBillPdf(
      pdfRecord.filePath,
      item.ID_HDON,
      item.MA_KHANG,
      item.MA_DVIQLY,
      {
        maSogcs: item.MA_SOGCS,
        kyHieu: item.KIHIEU_SERY,
        soSery: item.SO_SERY,
        ngayPhatHanh: new Date(item.NGAY_PHANH),
      },
    );

    if (result.success && result.bill) {
      await billRepo.upsert(result.bill);
      logger.debug(`[task ${taskHex}] parse OK invoiceId=${item.ID_HDON} ${item.MA_KHANG}`);
      success++;
    } else {
      await billRepo.markError(item.ID_HDON, pdfRecord.filePath, result.error ?? "unknown");
      logger.warn(`[task ${taskHex}] parse FAIL invoiceId=${item.ID_HDON}: ${result.error}`);
      failed++;
    }
  }

  logTaskPhase(
    taskHex,
    "PARSE_PDF",
    `Kỳ ${ky} T${thang}/${nam}: ${success} ok, ${failed} lỗi / ${pendingIds.size} cần xử lý`,
  );
  return { attempted: pendingIds.size, success, failed };
}

/**
 * Một task = một BrowserContext dùng `storageState` + một Page; luôn đóng page rồi context.
 */
export async function processNpcTask(
  task: ScrapeTask,
  repo: TaskRepository,
  npcWorker: EVNNPCWorker,
): Promise<void> {
  if (!task._id || task.provider !== "EVN_NPC") {
    return;
  }

  const taskId = task._id;
  const taskHex = taskId.toHexString();
  const npcRepo = new NpcAccountRepository();
  const accId = parseNpcAccountIdFromPayload(task.payload);
  const account = await npcRepo.findById(accId);
  if (!account) {
    await completeTaskFailed(repo, task, taskId, "Tài khoản NPC không tồn tại");
    return;
  }
  if (!account.enabled) {
    await completeTaskFailed(repo, task, taskId, `Tài khoản NPC đã tắt: ${account.username}`);
    return;
  }
  if (account.disabledReason === "wrong_password") {
    await completeTaskFailed(
      repo,
      task,
      taskId,
      `Tài khoản đã bị đánh dấu sai mật khẩu — không đăng nhập lại: ${account.username}`,
    );
    return;
  }

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let browserSessionStarted = false;

  try {
    logTaskPhase(taskHex, "CLAIMED", `NPC — ${account.username}`);

    await npcWorker.beginBrowserSession();
    browserSessionStarted = true;
    logTaskPhase(taskHex, "BROWSER", "đã mở phiên Chromium (NPC)");

    const storage = normalizeStorageState(account.storageStateJson ?? undefined);
    context = await npcWorker.createDisposableContext(storage);
    page = await context.newPage();

    if (task.payload.kind === "online_payment_link") {
      const secret = env.npcCredentialsSecret.trim();
      if (!secret) {
        throw new Error("Thiếu NPC_CREDENTIALS_SECRET — không thể giải mã mật khẩu");
      }
      const password = decryptNpcPassword(account.passwordEncrypted, secret);
      const step = env.npcStepTimeoutMs;
      await npcWorker.prepareNpcIndexNpcSession(page, account, accId, password, taskHex, step);
      const rawMa =
        typeof task.payload.maKhachHang === "string" ? task.payload.maKhachHang : "";
      const rawTrim = rawMa.replace(/\u00A0/g, " ").replace(/[\u2000-\u200B\uFEFF]/g, "").trim();
      const resolvedMa = rawTrim !== "" ? rawMa : account.username;
      const maNorm = normalizeNpcMaKhachHangInput(resolvedMa);
      if (!maNorm.ok) {
        await completeTaskFailed(repo, task, taskId, maNorm.message);
        logTaskPhase(taskHex, "FAILED", maNorm.message);
        return;
      }
      const maKh = maNorm.ma;
      logTaskPhase(taskHex, "NPC_ONLINE_PAYMENT", `Tra cứu link thanh toán ma=${maKh}`);
      const onlinePaymentLink = await fetchNpcOnlinePaymentLink(page, maKh, step);
      const storageAfter = await page.context().storageState();
      await npcRepo.updateSession(accId, JSON.stringify(storageAfter), new Date());
      const meta: InvoiceDownloadMetadata = {
        downloadedAt: new Date().toISOString(),
        lookupPayload: {
          onlinePaymentLink: onlinePaymentLink as unknown as Record<string, unknown>,
        },
      };
      await completeTaskSuccess(repo, task, taskId, meta);
      logTaskPhase(
        taskHex,
        "SUCCESS",
        onlinePaymentLink.ok
          ? `NPC online_payment_link OK — ${account.username} ma=${maKh}`
          : `NPC online_payment_link hoàn tất (nghiệp vụ) — ${account.username} ma=${maKh} code=${onlinePaymentLink.code}`,
      );
      return;
    }

    const metadata = await npcWorker.runTask(page, task, taskHex);
    await completeTaskSuccess(repo, task, taskId, metadata);
    logTaskPhase(taskHex, "SUCCESS", `NPC đăng nhập + lưu session — ${account.username}`);
  } catch (err) {
    const msg = formatError(err);
    await completeTaskFailed(repo, task, taskId, msg);
    logTaskPhase(taskHex, "FAILED", msg.split("\n")[0]?.slice(0, 500) ?? "unknown error");
  } finally {
    if (page && env.playwrightPauseBeforeCloseMs > 0) {
      logger.info(
        `[playwright] Tạm dừng ${env.playwrightPauseBeforeCloseMs}ms trước khi đóng trang (PLAYWRIGHT_PAUSE_BEFORE_CLOSE_MS)...`,
      );
      await new Promise((r) => setTimeout(r, env.playwrightPauseBeforeCloseMs));
    }
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browserSessionStarted) {
      await npcWorker.endBrowserSession();
      logTaskPhase(taskHex, "BROWSER_CLOSED", "đã kết thúc phiên Chromium cho task NPC");
    }
  }
}

export async function processTask(
  task: ScrapeTask,
  repo: TaskRepository,
  evnWorker: EVNCPCWorker,
): Promise<void> {
  if (!task._id) {
    return;
  }
  if (task.provider === "EVN_NPC") {
    throw new Error("EVN_NPC phải xử lý qua processNpcTask");
  }

  const taskId = task._id;
  const taskHex = taskId.toHexString();
  const ky = String(task.payload.period ?? task.payload.ky ?? "1");
  const thang = String(task.payload.month ?? task.payload.thang ?? "01");
  const nam = String(task.payload.year ?? task.payload.nam ?? new Date().getFullYear());

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let browserSessionStarted = false;

  try {
    logTaskPhase(taskHex, "CLAIMED", `Kỳ ${ky} tháng ${thang} năm ${nam} — bắt đầu pipeline`);

    // EVN CPC: chỉ mở Chromium khi có task; đóng hẳn khi task xong (refcount nếu concurrency > 1).
    await evnWorker.beginBrowserSession();
    browserSessionStarted = true;
    logTaskPhase(taskHex, "BROWSER", "đã mở phiên Chromium");
    const storage = normalizeStorageState(
      task.sessionData as string | Record<string, unknown> | undefined,
    );
    context = await evnWorker.createDisposableContext(storage);
    page = await context.newPage();

    const metadata = await evnWorker.runTask(page, task, taskHex);

    // Tự động parse PDF ngay sau khi scrape + download xong
    const parseSync = await autoParseNewPdfs(taskHex, ky, thang, nam);

    const fullMeta: InvoiceDownloadMetadata = { ...metadata, parseSync };
    await completeTaskSuccess(repo, task, taskId, fullMeta);
    logTaskPhase(
      taskHex,
      "SUCCESS",
      `invoice ${metadata.invoiceSync?.total ?? 0} | pdf ok ${metadata.pdfSync?.success ?? 0}/${metadata.pdfSync?.attempted ?? 0} | parse ok ${parseSync.success}/${parseSync.attempted}`,
    );
  } catch (err) {
    const msg = formatError(err);
    await completeTaskFailed(repo, task, taskId, msg);
    logTaskPhase(taskHex, "FAILED", msg.split("\n")[0]?.slice(0, 500) ?? "unknown error");
  } finally {
    if (page && env.playwrightPauseBeforeCloseMs > 0) {
      logger.info(
        `[playwright] Tạm dừng ${env.playwrightPauseBeforeCloseMs}ms trước khi đóng trang (PLAYWRIGHT_PAUSE_BEFORE_CLOSE_MS)...`,
      );
      await new Promise((r) => setTimeout(r, env.playwrightPauseBeforeCloseMs));
    }
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browserSessionStarted) {
      await evnWorker.endBrowserSession();
      logTaskPhase(taskHex, "BROWSER_CLOSED", "đã kết thúc phiên Chromium cho task này");
    }
  }
}

/**
 * Lấy task theo claim nguyên tử rồi xử lý (dùng trong vòng lặp poll).
 */
/**
 * Xử lý một task EVN_HANOI: đăng nhập phiên, tra cứu hóa đơn / lấy link thanh toán.
 */
export async function processHanoiTask(
  task: ScrapeTask,
  repo: TaskRepository,
  hanoiWorker: EVNHanoiWorker,
): Promise<void> {
  if (!task._id || task.provider !== "EVN_HANOI") {
    return;
  }

  const taskId = task._id;
  const taskHex = taskId.toHexString();
  const hanoiRepo = new HanoiAccountRepository();
  const accId = parseHanoiAccountIdFromPayload(task);
  const account = await hanoiRepo.findById(accId);
  if (!account) {
    await completeTaskFailed(repo, task, taskId, "Tài khoản Hanoi không tồn tại");
    return;
  }
  if (!account.enabled) {
    await completeTaskFailed(repo, task, taskId, `Tài khoản Hanoi đã tắt: ${account.username}`);
    return;
  }
  if (account.disabledReason === "wrong_password") {
    await completeTaskFailed(
      repo,
      task,
      taskId,
      `Tài khoản Hanoi đã bị đánh dấu sai mật khẩu — không đăng nhập lại: ${account.username}`,
    );
    return;
  }

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let browserSessionStarted = false;

  try {
    logTaskPhase(taskHex, "CLAIMED", `Hanoi — ${account.username}`);

    if (env.hanoiUseApiLogin) {
      const metadata = await hanoiWorker.runTaskApiFirst(task, taskHex);
      await completeTaskSuccess(repo, task, taskId, metadata);
      logTaskPhase(taskHex, "SUCCESS", `Hanoi STS API — ${account.username}`);
      return;
    }

    await hanoiWorker.beginBrowserSession();
    browserSessionStarted = true;
    logTaskPhase(taskHex, "BROWSER", "đã mở phiên Chromium (Hanoi — HANOI_USE_API_LOGIN=false)");

    const storage = normalizeStorageState(account.storageStateJson ?? undefined);
    context = await hanoiWorker.createDisposableContext(storage);
    page = await context.newPage();

    const metadata = await hanoiWorker.runTask(page, task, taskHex);
    await completeTaskSuccess(repo, task, taskId, metadata);
    logTaskPhase(taskHex, "SUCCESS", `Hanoi Playwright — ${account.username}`);
  } catch (err) {
    const msg = formatError(err);
    await completeTaskFailed(repo, task, taskId, msg);
    logTaskPhase(taskHex, "FAILED", msg.split("\n")[0]?.slice(0, 500) ?? "unknown error");
  } finally {
    if (page && env.playwrightPauseBeforeCloseMs > 0) {
      logger.info(
        `[playwright] Tạm dừng ${env.playwrightPauseBeforeCloseMs}ms trước khi đóng trang (PLAYWRIGHT_PAUSE_BEFORE_CLOSE_MS)...`,
      );
      await new Promise((r) => setTimeout(r, env.playwrightPauseBeforeCloseMs));
    }
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browserSessionStarted) {
      await hanoiWorker.endBrowserSession();
      logTaskPhase(taskHex, "BROWSER_CLOSED", "đã kết thúc phiên Chromium cho task Hanoi");
    }
  }
}

export async function claimAndProcessNext(
  repo: TaskRepository,
  evnWorker: EVNCPCWorker,
  npcWorker: EVNNPCWorker,
  workerInstanceId: string,
  hanoiWorker?: EVNHanoiWorker,
): Promise<boolean> {
  const task = await repo.claimNextPending(workerInstanceId);
  if (!task) return false;
  if (task.provider === "EVN_NPC") {
    await processNpcTask(task, repo, npcWorker);
  } else if (task.provider === "EVN_HANOI") {
    if (!hanoiWorker) {
      throw new Error("EVN_HANOI task nhưng hanoiWorker chưa được cấu hình trong TaskRunner");
    }
    await processHanoiTask(task, repo, hanoiWorker);
  } else {
    await processTask(task, repo, evnWorker);
  }
  return true;
}

export function createWorkerId(): string {
  return `evn-worker-${randomUUID()}`;
}
