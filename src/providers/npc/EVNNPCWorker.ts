import type { Page } from "playwright";
import { BaseWorker } from "../../core/BaseWorker.js";
import { env } from "../../config/env.js";
import type { InvoiceDownloadMetadata, ScrapeTask } from "../../types/task.js";
import { NpcAccountRepository } from "../../db/npcAccountRepository.js";
import { decryptNpcPassword } from "../../services/crypto/npcCredentials.js";
import {
  dismissNpcOverlayModalIfPresent,
  isLikelyNpcLoggedInSession,
  isStillOnNpcLoginPage,
  loginNpcInteractive,
} from "./npcLogin.js";
import { isNpcLoginWrongCredentialsError } from "./npcLoginErrors.js";
import { parseNpcAccountIdFromPayload } from "./npcTaskPayload.js";
import { logTaskPhase, logger } from "../../core/logger.js";
import { npcHumanPause } from "../../services/npc/npcBrowserLikeHeaders.js";
import { fetchNpcTraCuuHdsPc } from "../../services/npc/NpcTraCuuHDSPCClient.js";
import { parseNpcBillDataFromTraCuuBody, selectNpcPaymentBillRowForKy } from "../../services/npc/parseNpcBillData.js";
import { postNpcXemChiTietHoaDon, postNpcXemHoaDonNpc } from "../../services/npc/NpcXemChiTietHoaDonClient.js";
import { saveNpcInvoicePdf } from "../../services/npc/saveNpcInvoicePdf.js";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import { parseElectricityBillPdf } from "../../services/pdf/ElectricityBillParser.js";
import { npcInvoiceIdSurrogateFromIdHdon, type NpcPdfKind } from "../../services/npc/npcElectricityBillId.js";
import {
  fetchNpcOnlinePaymentLink,
  type NpcOnlinePaymentLinkResult,
} from "../../services/npc/npcOnlinePaymentLink.js";
import type { ObjectId } from "mongodb";
import type { NpcAccount } from "../../types/npcAccount.js";

export class EVNNPCWorker extends BaseWorker {
  private readonly npcRepo = new NpcAccountRepository();
  private readonly billRepo = new ElectricityBillRepository();

  /**
   * Đăng nhập (nếu cần) và đảm bảo đang ở IndexNPC; lưu `storageState` vào DB.
   * Dùng lại cho task quét và API lấy link thanh toán trực tuyến.
   */
  async prepareNpcIndexNpcSession(
    page: Page,
    account: NpcAccount,
    accountId: ObjectId,
    password: string,
    traceTaskId: string,
    step: number,
  ): Promise<void> {
    const trace = (phase: string, detail?: string) => logTaskPhase(traceTaskId, phase, detail);
    trace("NPC_ACCOUNT", account.username);

    /**
     * Bước đầu: mở IndexNPC để probe session. Trang NPC đôi khi chậm / WAF — cho phép 2 lần `goto`
     * trong một `runStep` với budget > `step` (mặc định `NPC_STEP_TIMEOUT_MS` trên server thường 45–90s).
     */
    const probeSessionBudgetMs = Math.min(step * 2 + 12_000, 200_000);
    await this.runStep("npc:probeSession", probeSessionBudgetMs, async () => {
      const gotoIndexOnce = async () => {
        await page.goto(env.evnNpcIndexNpcUrl, { waitUntil: "domcontentloaded", timeout: step });
        await new Promise<void>((r) => setTimeout(r, 500));
      };
      try {
        await gotoIndexOnce();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const retryable =
          /timeout|timed out|Navigation|net::ERR_|NS_ERROR|Target page|closed/i.test(msg);
        if (!retryable) throw err;
        logger.warn(
          `[task ${traceTaskId}] npc:probeSession — lần 1 lỗi (${msg.slice(0, 200)}), chờ 2s rồi thử lại...`,
        );
        await new Promise<void>((r) => setTimeout(r, 2000));
        await gotoIndexOnce();
      }
    });

    await this.runStep("npc:dismissModalAfterProbe", step, async () => {
      await dismissNpcOverlayModalIfPresent(page, step);
    });

    let loggedIn = await isLikelyNpcLoggedInSession(page);

    if (!loggedIn) {
      trace("NPC_LOGIN", "phiên hết hạn hoặc chưa có — đăng nhập + captcha");
      try {
        await loginNpcInteractive(
          page,
          account.username,
          password,
          (n, t, f) => this.runStep(n, t, f),
          step,
          (opts) => this.handleCaptchaWithRetry(opts),
        );
      } catch (err) {
        if (isNpcLoginWrongCredentialsError(err)) {
          await this.npcRepo.markInvalidCredentials(accountId, "wrong_password");
          throw new Error(
            `NPC: sai mật khẩu hoặc tài khoản không hợp lệ — đã tắt tài khoản ${account.username} (disabledReason=wrong_password).`,
          );
        }
        throw err;
      }
      loggedIn = await isLikelyNpcLoggedInSession(page);
      if (!loggedIn) {
        throw new Error("Đăng nhập NPC: vẫn ở màn đăng nhập hoặc trang chủ khách (chưa có session).");
      }
    } else {
      trace("NPC_LOGIN", "đã có session hợp lệ (storageState)");
    }

    await this.runStep("npc:gotoIndexNpc", step, async () => {
      if (!page.url().toLowerCase().includes("indexnpc")) {
        await page.goto(env.evnNpcIndexNpcUrl, { waitUntil: "domcontentloaded", timeout: step });
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    });
    await this.runStep("npc:dismissModalOnIndexNpc", step, async () => {
      await dismissNpcOverlayModalIfPresent(page, step);
    });
    if (!page.url().toLowerCase().includes("indexnpc") || (await isStillOnNpcLoginPage(page))) {
      throw new Error(
        "NPC: không vào được DichVuTTCSKH/IndexNPC hoặc vẫn thấy màn đăng nhập — kiểm tra session / EVN_NPC_INDEX_NPC_URL.",
      );
    }

    const storage = await page.context().storageState();
    const storageJson = JSON.stringify(storage);
    await this.npcRepo.updateSession(accountId, storageJson, new Date());
    logger.debug(`[task ${traceTaskId}] Đã lưu storageState cho NPC ${account.username}`);
  }

  async runTask(page: Page, task: ScrapeTask, traceTaskId: string): Promise<InvoiceDownloadMetadata> {
    const step = env.npcStepTimeoutMs;
    const trace = (phase: string, detail?: string) => logTaskPhase(traceTaskId, phase, detail);

    const accountId = parseNpcAccountIdFromPayload(task.payload);
    const account = await this.npcRepo.findById(accountId);
    if (!account) {
      throw new Error(`Không tìm thấy npc_accounts._id=${accountId.toHexString()}`);
    }
    if (!account.enabled) {
      throw new Error(`Tài khoản NPC đã tắt: ${account.username}`);
    }
    if (account.disabledReason === "wrong_password") {
      throw new Error(
        `Tài khoản NPC đã bị đánh dấu sai mật khẩu — không đăng nhập lại: ${account.username}`,
      );
    }

    const secret = env.npcCredentialsSecret.trim();
    if (!secret) {
      throw new Error("Thiếu NPC_CREDENTIALS_SECRET — không thể giải mã mật khẩu");
    }
    const password = decryptNpcPassword(account.passwordEncrypted, secret);

    await this.prepareNpcIndexNpcSession(page, account, accountId, password, traceTaskId, step);

    let onlinePaymentLink: NpcOnlinePaymentLinkResult | undefined;
    if (env.npcFetchOnlinePaymentLinkAfterLogin) {
      await npcHumanPause();
      trace("NPC_ONLINE_PAYMENT", "Tra cứu link thanh toán trực tuyến (apicskhthanhtoan)");
      onlinePaymentLink = await fetchNpcOnlinePaymentLink(page, account.username.trim().toUpperCase(), step);
      const storage2 = await page.context().storageState();
      await this.npcRepo.updateSession(accountId, JSON.stringify(storage2), new Date());
    }

    const { period, month, year } = resolveNpcPeriod(task);
    const kyList = resolveNpcKyList(task, period);
    trace("NPC_PERIOD", `Kỳ [${kyList.join(",")}] tháng ${month} năm ${year} — TraCuuHDSPC`);

    const thangNum = String(Number.parseInt(month, 10));
    const traCuuResults: Array<{
      ky: string;
      status: number;
      statusText: string;
      url: string;
      bodyLength: number;
      bodyPreview: string;
      billCount: number;
      idHdons: string[];
    }> = [];

    const xemChiTietResults: Array<{
      ky: string;
      id_hdon: string;
      status: number;
      statusText: string;
      bodyLength: number;
      bodyPreview?: string;
      pdfSavedPath?: string;
      pdfBytes?: number;
    }> = [];
    const xemHoaDonNpcResults: Array<{
      ky: string;
      id_hdon: string;
      npcPdfKind: NpcPdfKind;
      status: number;
      statusText: string;
      bodyLength: number;
      bodyPreview?: string;
      pdfSavedPath?: string;
      pdfBytes?: number;
    }> = [];
    let npcPdfAttempted = 0;
    let npcPdfSaved = 0;
    let parseAttempted = 0;
    let parseSuccess = 0;
    let parseFailed = 0;

    for (const ky of kyList) {
      await npcHumanPause();
      const r = await this.runStep(`npc:traCuuHDSPC:ky${ky}`, step, () =>
        fetchNpcTraCuuHdsPc(page, { ky, thang: month, nam: year }),
      );
      if (r.status >= 400) {
        logger.warn(`[task ${traceTaskId}] TraCuuHDSPC ky=${ky} HTTP ${r.status} ${r.statusText}`);
      }

      const bills = r.status < 400 ? parseNpcBillDataFromTraCuuBody(r.body) : [];
      trace("NPC_BILLS", `ky=${ky} bills=${bills.length}`);

      traCuuResults.push({
        ky,
        status: r.status,
        statusText: r.statusText,
        url: r.url,
        bodyLength: r.body.length,
        bodyPreview: r.body.slice(0, 4096),
        billCount: bills.length,
        idHdons: bills.map((b) => b.id_hdon).filter(Boolean),
      });

      for (const bill of bills) {
        const idHdon = bill.id_hdon?.trim();
        if (!idHdon) continue;
        const maKh = (bill.customer_code ?? account.username).trim();
        npcPdfAttempted++;
        await npcHumanPause();

        const detail = await this.runStep(`npc:xemChiTiet:ky${ky}:${idHdon.slice(0, 12)}`, step, () =>
          postNpcXemChiTietHoaDon(page, {
            idHdon,
            maKh,
            ky,
            thang: thangNum,
            nam: year,
          }),
        );

        if (detail.status >= 400) {
          logger.warn(
            `[task ${traceTaskId}] XemChiTietHoaDon_NPC id_hdon=${idHdon.slice(0, 16)}… HTTP ${detail.status}`,
          );
        }

        let pdfSavedPath: string | undefined;
        let pdfBytes: number | undefined;
        let bodyPreview: string | undefined;
        const bodyLen = detail.kind === "pdf" ? detail.buffer.length : detail.body.length;

        if (detail.kind === "pdf") {
          pdfSavedPath = await saveNpcInvoicePdf(detail.buffer, maKh, year, month, String(ky), idHdon);
          pdfBytes = detail.buffer.length;
          npcPdfSaved++;
          trace("NPC_PDF", `${pdfSavedPath} (${pdfBytes} bytes)`);

          const invSurrogate = npcInvoiceIdSurrogateFromIdHdon(idHdon);
          const series = typeof bill.series === "string" ? bill.series : "";
          parseAttempted++;
          const k = parseInt(String(ky), 10);
          const kyTrongKy = (k >= 1 && k <= 3 ? k : 1) as 1 | 2 | 3;
          const pr = await parseElectricityBillPdf(
            pdfSavedPath,
            invSurrogate,
            maKh.toUpperCase(),
            "NPC",
            {
              maSogcs: series,
              kyHieu: series,
              soSery: "",
              ngayPhatHanh: new Date(),
            },
            { npc: { npcIdHdon: idHdon, kyTrongKy } },
          );
          if (pr.success && pr.bill) {
            await this.billRepo.upsert(pr.bill);
            parseSuccess++;
            trace("NPC_PARSE", `electricity_bills billKey=${pr.bill.billKey ?? "?"}`);
          } else {
            parseFailed++;
            await this.billRepo.markNpcError(idHdon, invSurrogate, pdfSavedPath, pr.error ?? "parse failed");
            logger.warn(`[task ${traceTaskId}] Parse PDF NPC id_hdon=${idHdon.slice(0, 12)}… — ${pr.error}`);
          }
        } else {
          bodyPreview = detail.body.slice(0, 4096);
          if (detail.status < 400) {
            logger.warn(
              `[task ${traceTaskId}] XemChiTiet trả HTML/text (chưa tách được PDF) id_hdon=${idHdon.slice(0, 12)}… — xem bodyPreview metadata`,
            );
          }
        }

        xemChiTietResults.push({
          ky,
          id_hdon: idHdon,
          status: detail.status,
          statusText: detail.statusText,
          bodyLength: bodyLen,
          bodyPreview,
          pdfSavedPath,
          pdfBytes,
        });
      }

      /**
       * HĐ GTGT/thanh toán: cùng `ky`/`thang`/`nam` như TraCuu và XemChiTiet thông báo — không có task/API
       * riêng “chỉ tải GTGT”; luôn đi kèp sau các PDF thông báo của kỳ đó (khi bật env).
       */
      if (env.npcDownloadPaymentPdf && r.status < 400 && bills.length > 0) {
        const paymentRow = selectNpcPaymentBillRowForKy(bills);
        const idPay = paymentRow?.id_hdon?.trim();
        if (paymentRow && idPay) {
          const maKhPay = (paymentRow.customer_code ?? account.username).trim();
          await npcHumanPause();
          npcPdfAttempted++;
          const payDetail = await this.runStep(`npc:xemHoaDon:ky${ky}:${idPay.slice(0, 12)}`, step, () =>
            postNpcXemHoaDonNpc(page, {
              idHdon: idPay,
              maKh: maKhPay,
              ky,
              thang: thangNum,
              nam: year,
            }),
          );
          if (payDetail.status >= 400) {
            logger.warn(
              `[task ${traceTaskId}] XemHoaDon_NPC id_hdon=${idPay.slice(0, 16)}… HTTP ${payDetail.status}`,
            );
          }
          let pdfSavedPath: string | undefined;
          let pdfBytes: number | undefined;
          let bodyPreview: string | undefined;
          const payLen = payDetail.kind === "pdf" ? payDetail.buffer.length : payDetail.body.length;
          if (payDetail.kind === "pdf") {
            pdfSavedPath = await saveNpcInvoicePdf(
              payDetail.buffer,
              maKhPay,
              year,
              month,
              String(ky),
              idPay,
              "thanh_toan",
            );
            pdfBytes = payDetail.buffer.length;
            npcPdfSaved++;
            trace("NPC_PDF_TT", `${pdfSavedPath} (${pdfBytes} bytes)`);
            const invSurrogate = npcInvoiceIdSurrogateFromIdHdon(idPay, "thanh_toan");
            const series = typeof paymentRow.series === "string" ? paymentRow.series : "";
            parseAttempted++;
            const k2 = parseInt(String(ky), 10);
            const kyTrongKy2 = (k2 >= 1 && k2 <= 3 ? k2 : 1) as 1 | 2 | 3;
            const pr = await parseElectricityBillPdf(
              pdfSavedPath,
              invSurrogate,
              maKhPay.toUpperCase(),
              "NPC",
              {
                maSogcs: series,
                kyHieu: series,
                soSery: "",
                ngayPhatHanh: new Date(),
              },
              { npc: { npcIdHdon: idPay, kyTrongKy: kyTrongKy2, npcPdfKind: "thanh_toan" } },
            );
            if (pr.success && pr.bill) {
              await this.billRepo.upsert(pr.bill);
              parseSuccess++;
              trace("NPC_PARSE_TT", `electricity_bills billKey=${pr.bill.billKey ?? "?"}`);
            } else {
              parseFailed++;
              await this.billRepo.markNpcError(
                idPay,
                invSurrogate,
                pdfSavedPath,
                pr.error ?? "parse failed",
                "thanh_toan",
              );
              logger.warn(`[task ${traceTaskId}] Parse PDF NPC (TT) id_hdon=${idPay.slice(0, 12)}… — ${pr.error}`);
            }
          } else {
            bodyPreview = payDetail.body.slice(0, 4096);
            if (payDetail.status < 400) {
              logger.warn(
                `[task ${traceTaskId}] XemHoaDon_NPC trả HTML/text (chưa tách PDF) id_hdon=${idPay.slice(0, 12)}…`,
              );
            }
          }
          xemHoaDonNpcResults.push({
            ky,
            id_hdon: idPay,
            npcPdfKind: "thanh_toan",
            status: payDetail.status,
            statusText: payDetail.statusText,
            bodyLength: payLen,
            bodyPreview,
            pdfSavedPath,
            pdfBytes,
          });
        }
      }
    }

    if (traCuuResults.length > 0 && traCuuResults.every((t) => t.status >= 400)) {
      const statuses = traCuuResults.map((t) => `ky${t.ky}=${t.status}`).join(", ");
      throw new Error(
        `NPC TraCuuHDSPC: mọi kỳ đều lỗi HTTP (${statuses}). Có thể WAF/403, IP máy chủ bị hạn chế, hoặc phiên không đủ quyền — thử WORKER_CONCURRENCY=1; chi tiết trong metadata traCuuHdsPc.`,
      );
    }

    const downloadedAt = new Date().toISOString();
    return {
      downloadedAt,
      pdfSync:
        npcPdfAttempted > 0
          ? {
              attempted: npcPdfAttempted,
              success: npcPdfSaved,
              failed: npcPdfAttempted - npcPdfSaved,
              failedIds: [],
            }
          : undefined,
      parseSync:
        parseAttempted > 0
          ? { attempted: parseAttempted, success: parseSuccess, failed: parseFailed }
          : undefined,
      lookupPayload: {
        provider: "EVN_NPC",
        npcAccountId: accountId.toHexString(),
        username: account.username,
        period,
        month,
        year,
        kyList,
        traCuuHdsPc: traCuuResults,
        xemChiTietHoaDonNpc: xemChiTietResults,
        xemHoaDonNpc: xemHoaDonNpcResults,
        ...(onlinePaymentLink !== undefined ? { onlinePaymentLink } : {}),
      },
    };
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function resolveNpcPeriod(task: ScrapeTask): { period: string; month: string; year: string } {
  const p = task.payload;
  const now = new Date();
  const period = String(p.period ?? p.ky ?? "1");
  const monthRaw = p.month ?? p.thang ?? pad2(now.getMonth() + 1);
  const month = pad2(Number.parseInt(String(monthRaw), 10) || now.getMonth() + 1);
  const year = String(p.year ?? p.nam ?? now.getFullYear());
  return { period, month, year };
}

/**
 * Một tháng có thể có nhiều kỳ (vd. 1,2,3). Payload tuỳ chọn:
 * - `kyList` / `npcKyList` / `periods`: mảng số hoặc chuỗi (ưu tiên theo thứ tự đó).
 */
function resolveNpcKyList(task: ScrapeTask, defaultKy: string): string[] {
  const p = task.payload;
  const raw = p.kyList ?? p.npcKyList ?? p.periods;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((x) => String(x).trim()).filter((s) => s.length > 0);
  }
  return [String(defaultKy).trim() || "1"];
}
