import type { Page } from "playwright";
import { BaseWorker } from "../../core/BaseWorker.js";
import { env } from "../../config/env.js";
import type { InvoiceDownloadMetadata, ScrapeTask } from "../../types/task.js";
import type { TraCuuHDDTResponse } from "../../types/invoiceItem.js";
import { InvoiceItemRepository } from "../../db/invoiceItemRepository.js";
import { EvnCpcPdfClient, type PdfFileType } from "../../services/evn/EvnCpcPdfClient.js";
import { evnCpcSelectors } from "./evnCpcSelectors.js";
import {
  setInvoiceKyThangNamViaAntSelect,
  setInvoiceKyThangNamViaHiddenInputs,
  setInvoiceKyThangNamViaReactSelect,
} from "./evnCpcInvoiceForm.js";
import { loginEvnCpc } from "./evnCpcLogin.js";
import { logTaskPhase, logger } from "../../core/logger.js";

const DEFAULT_STEP_MS = 45_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function resolveInvoicePeriod(task: ScrapeTask): { period: string; month: string; year: string } {
  const p = task.payload;
  const now = new Date();
  const period = String(p.period ?? p.ky ?? "1");
  const monthRaw = p.month ?? p.thang ?? pad2(now.getMonth() + 1);
  const month = pad2(Number.parseInt(String(monthRaw), 10) || now.getMonth() + 1);
  const year = String(p.year ?? p.nam ?? now.getFullYear());
  return { period, month, year };
}

/** Tránh `goto` thừa khi đã đúng URL */
function needsNavigateToLookup(currentUrl: string, targetUrl: string): boolean {
  try {
    const cur = new URL(currentUrl);
    const tgt = new URL(targetUrl);
    const norm = (path: string) => path.replace(/\/$/, "") || "/";
    return (
      cur.origin !== tgt.origin ||
      norm(cur.pathname) !== norm(tgt.pathname) ||
      cur.search !== tgt.search
    );
  } catch {
    return true;
  }
}

/** Trích Bearer token từ Authorization header của bất kỳ request authenticated nào */
function extractBearerFromAuthHeader(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? (m[1] ?? null) : null;
}

function parseTraCuuPeriodMonthYearFromUrl(urlStr: string): { period: string | null; month: string | null; year: string | null } {
  try {
    const u = new URL(urlStr);
    return {
      period: u.searchParams.get("period"),
      month: u.searchParams.get("month"),
      year: u.searchParams.get("year"),
    };
  } catch {
    return { period: null, month: null, year: null };
  }
}

export class EVNCPCWorker extends BaseWorker {
  private readonly invoiceRepo = new InvoiceItemRepository();

  async runTask(page: Page, task: ScrapeTask, traceTaskId: string): Promise<InvoiceDownloadMetadata> {
    const step = DEFAULT_STEP_MS;
    const trace = (phase: string, detail?: string) => logTaskPhase(traceTaskId, phase, detail);

    // Bắt Bearer token từ bất kỳ request authenticated nào trong phiên này
    let bearerToken: string | null = null;
    page.on("request", (req) => {
      if (bearerToken) return;
      const token = extractBearerFromAuthHeader(req.headers()["authorization"] ?? null);
      if (token) {
        bearerToken = token;
        logger.debug(`[task ${traceTaskId}] Bearer token đã bắt (${token.length} ký tự)`);
      }
    });

    const hasEnvCreds = Boolean(env.evnCpcLoginUsername.trim() && env.evnCpcLoginPassword);
    const hasSession =
      task.sessionData != null &&
      (typeof task.sessionData === "string" ? task.sessionData.trim().length > 0 : true);

    trace("LOGIN", hasEnvCreds ? "đăng nhập bằng env" : "dùng sessionData / cookie");
    if (hasEnvCreds) {
      await loginEvnCpc(page, (n, t, f) => this.runStep(n, t, f), step);
    } else if (!hasSession) {
      throw new Error(
        "Cần cấu hình EVN_CPC_LOGIN_USERNAME + EVN_CPC_LOGIN_PASSWORD trong .env, hoặc task.sessionData (cookie đã đăng nhập)",
      );
    }

    await this.runStep("evn:gotoInvoiceLookup", step, async () => {
      if (needsNavigateToLookup(page.url(), env.evnCpcLookupUrl)) {
        await page.goto(env.evnCpcLookupUrl, { waitUntil: "domcontentloaded", timeout: step });
      }
    });

    await this.runStep("evn:waitInvoiceForm", step, async () => {
      await page.locator(evnCpcSelectors.invoiceLookupForm).waitFor({
        state: "visible",
        timeout: step,
      });
    });

    const inv = resolveInvoicePeriod(task);
    trace("FORM_PERIOD", `Kỳ ${inv.period} tháng ${inv.month} năm ${inv.year}`);
    await this.runStep("evn:setKyThangNam", step, async () => {
      const form = page.locator(evnCpcSelectors.invoiceLookupForm);
      const nReact = await form.locator(".cskh-custom-select").count();
      const nAnt = await form.locator(".ant-select").count();

      const verifyNativeKyThangNam = async (
        expected: { period: string; month: string; year: string },
      ): Promise<{ actual: { period: string | null; month: string | null; year: string | null }; ok: boolean }> => {
        const form = page.locator(evnCpcSelectors.invoiceLookupForm).first();
        const get = async (name: string): Promise<string | null> => {
          const el = form.locator(`input[name="${name}"]`).last();
          if ((await el.count()) === 0) return null;
          try {
            return await el.inputValue();
          } catch {
            return null;
          }
        };
        const actual = {
          period: await get("period"),
          month: await get("month"),
          year: await get("year"),
        };
        const ok = actual.period === expected.period && actual.month === expected.month && actual.year === expected.year;
        return { actual, ok };
      };

      // Trên UI đúng, react-select/ant-select sẽ ghi đúng vào state và native inputs.
      // Nếu lỗi menu (desktop) thì fallback sang native inputs.
      if (nReact >= 3) {
        try {
          await setInvoiceKyThangNamViaReactSelect(page, evnCpcSelectors.invoiceLookupForm, inv, step);
        } catch (err) {
          logger.warn(`[task ${traceTaskId}] react-select lỗi, thử hidden input: ${err instanceof Error ? err.message : err}`);
          await setInvoiceKyThangNamViaHiddenInputs(page, evnCpcSelectors.invoiceLookupForm, inv);
        }
      } else if (nAnt >= 3) {
        try {
          await setInvoiceKyThangNamViaAntSelect(page, evnCpcSelectors.invoiceLookupForm, inv, step);
        } catch (err) {
          logger.warn(`[task ${traceTaskId}] Ant Select lỗi, thử hidden input: ${err instanceof Error ? err.message : err}`);
          await setInvoiceKyThangNamViaHiddenInputs(page, evnCpcSelectors.invoiceLookupForm, inv);
        }
      } else {
        await setInvoiceKyThangNamViaHiddenInputs(page, evnCpcSelectors.invoiceLookupForm, inv);
      }

      // Cưỡng bức lại native inputs (để đảm bảo tuyệt đối) + verify.
      await setInvoiceKyThangNamViaHiddenInputs(page, evnCpcSelectors.invoiceLookupForm, inv);
      await sleep(400);

      const v = await verifyNativeKyThangNam(inv);
      if (!v.ok) {
        await setInvoiceKyThangNamViaHiddenInputs(page, evnCpcSelectors.invoiceLookupForm, inv);
        await sleep(400);
        const v2 = await verifyNativeKyThangNam(inv);
        // Không throw ở đây: desktop native input đang vỡ/khó ổn định.
        // Ta sẽ verify dựa trên URL request thực tế ở bước collectInvoiceList.
        if (!v2.ok) {
          logger.warn(
            `[task ${traceTaskId}] Native input khác payload (chỉ cảnh báo; verify theo URL request). ` +
              `expected period=${inv.period} month=${inv.month} year=${inv.year} ` +
              `actual period=${v2.actual.period} month=${v2.actual.month} year=${v2.actual.year}`,
          );
        }
      }
    });

    trace("CAPTCHA", "giải captcha và tra cứu");

    // Dùng synchronous event listener để bắt response traCuuHDDTTheoMST.
    // Không dùng waitForResponse (có timeout cứng) vì traCuuHDDTTheoMST được
    // frontend gửi SAU khi captcha thành công — tức sau khi handleCaptchaWithRetry return.
    let capturedInvoiceResp: import("playwright").Response | null = null;
    let capturedInvoiceReqUrl: string | null = null;
    const invoiceResponseHandler = (resp: import("playwright").Response): void => {
      if (resp.url().includes("traCuuHDDTTheoMST") && capturedInvoiceResp === null) {
        capturedInvoiceResp = resp;
      }
    };
    const invoiceRequestHandler = (req: import("playwright").Request): void => {
      if (capturedInvoiceReqUrl) return;
      if (req.url().includes("traCuuHDDTTheoMST")) {
        capturedInvoiceReqUrl = req.url();
      }
    };
    page.on("response", invoiceResponseHandler);
    page.on("request", invoiceRequestHandler);

    await this.handleCaptchaWithRetry({
      page,
      selectors: {
        captchaImage: evnCpcSelectors.captchaImage,
        captchaInput: `${evnCpcSelectors.invoiceLookupForm} ${evnCpcSelectors.captchaInput}`,
        changeCodeButton: evnCpcSelectors.changeCaptchaLink,
      },
      stepTimeoutMs: step,
      maxAttempts: 4,
      getImageBase64: async () => {
        const img = page.locator(evnCpcSelectors.captchaImage).first();
        const src = await img.getAttribute("src");
        if (!src) {
          throw new Error("Không đọc được src ảnh captcha");
        }
        if (src.startsWith("data:")) {
          const parts = src.split(",");
          const b64 = parts[1];
          if (!b64) throw new Error("data: URL captcha không có base64");
          return b64;
        }
        const buf = await img.screenshot({ type: "png" });
        return buf.toString("base64");
      },
      submit: async () => {
        // Lắng nghe phản hồi check-captcha TRƯỚC khi click (tránh bỏ lỡ response nhanh)
        const captchaApiUrlMatch = "check-captcha";
        const responsePromise = page
          .waitForResponse(
            (r) => r.url().includes(captchaApiUrlMatch),
            { timeout: 15_000 },
          )
          .catch(() => null);

        await page
          .locator(evnCpcSelectors.invoiceSearchButton)
          .first()
          .click({ timeout: step });

        // Ưu tiên đọc response từ API check-captcha
        const resp = await responsePromise;
        if (resp) {
          const body = await resp.text().catch(() => "");
          logger.debug(`[task ${traceTaskId}] check-captcha → HTTP ${resp.status()} ${body.slice(0, 120)}`);
          try {
            const json = JSON.parse(body) as { status?: number; response?: string };
            if (json.status === 200) {
              trace("CAPTCHA_OK", "check-captcha 200");
              return { shouldRetryCaptcha: false };
            }
            if (json.status === 400) {
              logger.warn(`[task ${traceTaskId}] Captcha sai — thử lại (${json.response ?? "failed"})`);
              return { shouldRetryCaptcha: true };
            }
            // status khác ngoài 200/400 — fallback theo HTTP status
            logger.warn(`[task ${traceTaskId}] check-captcha status lạ ${json.status} — thử lại`);
            return { shouldRetryCaptcha: true };
          } catch {
            // body không phải JSON — fallback theo HTTP status
          }
          if (resp.ok()) {
            trace("CAPTCHA_OK", `HTTP ${resp.status()}`);
            return { shouldRetryCaptcha: false };
          }
          logger.warn(`[task ${traceTaskId}] check-captcha HTTP ${resp.status()} không phải JSON — thử lại`);
          return { shouldRetryCaptcha: true };
        }

        // Fallback: kiểm tra text lỗi trên DOM nếu không có network event
        await page.waitForTimeout(1200);
        const failHint = page.getByText(/mã xác minh|xác minh không|sai mã|captcha failed/i).first();
        const shouldRetryCaptcha = await failHint.isVisible({ timeout: 2500 }).catch(() => false);
        return { shouldRetryCaptcha };
      },
    });

    // Xử lý danh sách hóa đơn — giữ listener sống để bắt response đến muộn
    let invoiceSync: InvoiceDownloadMetadata["invoiceSync"] | undefined;

    await this.runStep("evn:collectInvoiceList", step, async () => {
      // Poll tối đa 15s — frontend gửi traCuuHDDTTheoMST ngay sau captcha success
      if (!capturedInvoiceResp) {
        const deadline = Date.now() + 15_000;
        while (!capturedInvoiceResp && Date.now() < deadline) {
          await new Promise<void>((r) => setTimeout(r, 200)); // yield event loop
        }
      }

      // Listener không còn cần thiết
      page.off("response", invoiceResponseHandler);
      page.off("request", invoiceRequestHandler);

      if (!capturedInvoiceResp) {
        logger.warn(`[task ${traceTaskId}] Không nhận response traCuuHDDTTheoMST — bỏ qua lưu danh sách`);
        return;
      }

      const body = await capturedInvoiceResp.text().catch(() => "");
      logger.debug(
        `[task ${traceTaskId}] traCuuHDDTTheoMST HTTP ${capturedInvoiceResp.status()}, body ${body.length} bytes`,
      );

      // Xác thực kỳ/tháng/năm thực sự từ URL request.
      if (capturedInvoiceReqUrl) {
        const actual = parseTraCuuPeriodMonthYearFromUrl(capturedInvoiceReqUrl);
        const expectedPeriod = String(Number.parseInt(inv.period, 10));
        const expectedMonth = String(Number.parseInt(inv.month, 10));
        const expectedYear = String(inv.year);
        const actualPeriod = actual.period ? String(Number.parseInt(actual.period, 10)) : null;
        const actualMonth = actual.month ? String(Number.parseInt(actual.month, 10)) : null;
        const actualYear = actual.year ?? null;

        const ok =
          actualPeriod === expectedPeriod && actualMonth === expectedMonth && actualYear === expectedYear;

        if (!ok) {
          throw new Error(
            `[evn] traCuuHDDTTheoMST request mismatch. Expected (period=${expectedPeriod}, month=${expectedMonth}, year=${expectedYear}) ` +
              `but got (period=${actualPeriod ?? "null"}, month=${actualMonth ?? "null"}, year=${actualYear ?? "null"}).`,
          );
        }
      } else {
        logger.warn(`[task ${traceTaskId}] Không bắt URL request traCuuHDDTTheoMST — bỏ qua verify kỳ/tháng/năm`);
      }

      let parsed: TraCuuHDDTResponse;
      try {
        parsed = JSON.parse(body) as TraCuuHDDTResponse;
      } catch {
        logger.warn(`[task ${traceTaskId}] Không parse JSON danh sách hóa đơn`);
        return;
      }

      const items = parsed?.result;
      if (!Array.isArray(items) || items.length === 0) {
        trace("INVOICE_LIST", "rỗng (0 hóa đơn)");
        invoiceSync = { total: 0, inserted: 0, updated: 0, newIds: [] };
        return;
      }

      const result = await this.invoiceRepo.upsertMany(items);
      invoiceSync = {
        total: result.total,
        inserted: result.inserted,
        updated: result.updated,
        newIds: result.newItems.map((i) => i.ID_HDON),
      };
      trace(
        "INVOICE_DB",
        `${items.length} dòng API → upsert: ${result.inserted} mới, ${result.updated} cập nhật`,
      );
      if (result.newItems.length > 0) {
        const ids = result.newItems.map((i) => i.ID_HDON).join(", ");
        logger.debug(`[task ${traceTaskId}] ID_HDON mới: ${ids}`);
      }
    });

    // Tải PDF (thông báo) cho tất cả hóa đơn đã upsert
    let pdfSync: InvoiceDownloadMetadata["pdfSync"] | undefined;

    await this.runStep("evn:downloadPdfs", step * 4, async () => {
      if (!bearerToken) {
        logger.warn(`[task ${traceTaskId}] Không có Bearer token — bỏ qua tải PDF`);
        return;
      }

      // API lưu THANG không có leading zero ("3" chứ không phải "03")
      const thangNorm = String(Number.parseInt(inv.month, 10));

      // Luôn query DB — không chỉ dựa vào invoiceSync.total
      // Đảm bảo: kể cả khi response bị miss lần này, hóa đơn cũ có lỗi vẫn được retry
      const allItems = await this.invoiceRepo.findByKyThangNam(inv.period, thangNorm, inv.year);
      if (allItems.length === 0) {
        trace("PDF", "0 hóa đơn trong DB cho kỳ này — bỏ qua");
        return;
      }
      trace("PDF", `bắt đầu tải tối đa ${allItems.length} file TBAO`);
      const pdfClient = new EvnCpcPdfClient(bearerToken);

      let success = 0;
      let failed = 0;
      const failedIds: number[] = [];
      const FILE_TYPE: PdfFileType = "TBAO";

      for (const item of allItems) {
        const existing = item.pdfDownloads?.[FILE_TYPE];
        if (existing?.status === "ok") {
          logger.debug(`[task ${traceTaskId}] PDF skip ID_HDON=${item.ID_HDON} (đã có)`);
          success++;
          continue;
        }

        try {
          const result = await pdfClient.downloadAndSave({
            orgCode: item.MA_DVIQLY,
            billId: item.ID_HDON,
            fileType: FILE_TYPE,
            customerCode: item.MA_KHANG,
          });
          await this.invoiceRepo.markPdfDownloaded(item.ID_HDON, FILE_TYPE, {
            downloadedAt: new Date(),
            filePath: result.filePath,
            bytes: result.bytes,
            status: "ok",
          });
          success++;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.warn(`[task ${traceTaskId}] PDF lỗi ID_HDON=${item.ID_HDON}: ${error}`);
          await this.invoiceRepo.markPdfDownloaded(item.ID_HDON, FILE_TYPE, {
            downloadedAt: new Date(),
            filePath: "",
            bytes: 0,
            status: "error",
            error: error.slice(0, 500),
          }).catch(() => undefined);
          failed++;
          failedIds.push(item.ID_HDON);
        }
      }

      pdfSync = { attempted: allItems.length, success, failed, failedIds };
      trace("PDF_DONE", `${success} ok, ${failed} lỗi / ${allItems.length} dòng kỳ`);
    });

    return {
      downloadedAt: new Date().toISOString(),
      invoiceSync,
      pdfSync,
      lookupPayload: {
        ...task.payload,
        ...inv,
        pipelineStage: "pdfs_downloaded",
        pageUrlAfterSearch: page.url(),
      },
    };
  }
}
