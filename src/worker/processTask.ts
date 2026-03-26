import type { BrowserContext, Page } from "playwright";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { normalizeStorageState } from "../core/BaseWorker.js";
import type { TaskRepository } from "../db/taskRepository.js";
import type { ScrapeTask } from "../types/task.js";
import type { EVNCPCWorker } from "../providers/evn/EVNCPCWorker.js";
import { InvoiceItemRepository } from "../db/invoiceItemRepository.js";
import { ElectricityBillRepository } from "../db/electricityBillRepository.js";
import { parseElectricityBillPdf } from "../services/pdf/ElectricityBillParser.js";
import { logTaskPhase, logger } from "../core/logger.js";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
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
export async function processTask(
  task: ScrapeTask,
  repo: TaskRepository,
  evnWorker: EVNCPCWorker,
): Promise<void> {
  if (!task._id) {
    return;
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

    await repo.markSuccess(taskId, { ...metadata, parseSync });
    logTaskPhase(
      taskHex,
      "SUCCESS",
      `invoice ${metadata.invoiceSync?.total ?? 0} | pdf ok ${metadata.pdfSync?.success ?? 0}/${metadata.pdfSync?.attempted ?? 0} | parse ok ${parseSync.success}/${parseSync.attempted}`,
    );
  } catch (err) {
    const msg = formatError(err);
    await repo.markFailed(taskId, msg);
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
export async function claimAndProcessNext(
  repo: TaskRepository,
  evnWorker: EVNCPCWorker,
  workerInstanceId: string,
): Promise<boolean> {
  const task = await repo.claimNextPending(workerInstanceId);
  if (!task) return false;
  await processTask(task, repo, evnWorker);
  return true;
}

export function createWorkerId(): string {
  return `evn-worker-${randomUUID()}`;
}
