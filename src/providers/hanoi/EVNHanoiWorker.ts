import type { Page } from "playwright";
import { BaseWorker } from "../../core/BaseWorker.js";
import { env } from "../../config/env.js";
import type { InvoiceDownloadMetadata, ScrapeTask } from "../../types/task.js";
import { HanoiAccountRepository } from "../../db/hanoiAccountRepository.js";
import { decryptHanoiPassword } from "../../services/crypto/hanoiCredentials.js";
import {
  dismissHanoiOverlayIfPresent,
  isHanoiLoggedIn,
  loginHanoiInteractive,
} from "./hanoiLogin.js";
import { isHanoiLoginWrongCredentialsError } from "./hanoiLoginErrors.js";
import { parseHanoiAccountIdFromPayload } from "./hanoiTaskPayload.js";
import { logTaskPhase, logger } from "../../core/logger.js";
import { hanoiHumanPause } from "../../services/hanoi/hanoiBrowserLikeHeaders.js";
import {
  fetchHanoiOnlinePaymentLink,
  type HanoiOnlinePaymentLinkResult,
} from "../../services/hanoi/hanoiOnlinePaymentLink.js";
import { getOrRefreshHanoiAccessToken } from "../../services/hanoi/hanoiTokenClient.js";
import { ensureHanoiUserInfo } from "../../services/hanoi/hanoiUserInfoClient.js";
import { ensureHanoiHopDongSnapshot } from "../../services/hanoi/hanoiHopDongSync.js";
import { HanoiContractRepository } from "../../db/hanoiContractRepository.js";
import {
  distinctKyInRows,
  fetchHanoiGetThongTinHoaDon,
  filterHanoiThongTinRowsForPeriod,
} from "../../services/hanoi/hanoiGetThongTinHoaDonClient.js";
import type { ObjectId } from "mongodb";
import type { HanoiAccount } from "../../types/hanoiAccount.js";
import type { HanoiUserInfoSnapshot } from "../../types/hanoiUserInfo.js";
import type { HanoiDmThongTinHoaDonItem } from "../../types/hanoiGetThongTinHoaDon.js";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import { parseElectricityBillPdf } from "../../services/pdf/ElectricityBillParser.js";
import { fetchHanoiXemHoaDonPdf } from "../../services/hanoi/hanoiXemHoaDonPdfClient.js";
import { saveHanoiInvoicePdf } from "../../services/hanoi/saveHanoiInvoicePdf.js";
import { hanoiInvoiceIdSurrogateFromIdHdon } from "../../services/hanoi/hanoiElectricityBillId.js";

function parseVnSlashDate(s: string): Date {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return new Date();
  return new Date(`${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}T12:00:00.000Z`);
}

export class EVNHanoiWorker extends BaseWorker {
  private readonly hanoiRepo = new HanoiAccountRepository();
  private readonly billRepo = new ElectricityBillRepository();
  private readonly contractRepo = new HanoiContractRepository();

  /**
   * Pipeline không dùng Chromium: STS password grant + Bearer cho API sau.
   */
  async runTaskApiFirst(task: ScrapeTask, traceTaskId: string): Promise<InvoiceDownloadMetadata> {
    const step = env.hanoiStepTimeoutMs;
    const trace = (phase: string, detail?: string) => logTaskPhase(traceTaskId, phase, detail);

    const accountId = parseHanoiAccountIdFromPayload(task);
    const account = await this.hanoiRepo.findById(accountId);
    if (!account) {
      throw new Error(`Không tìm thấy hanoi_accounts._id=${accountId.toHexString()}`);
    }
    if (!account.enabled) {
      throw new Error(`Tài khoản Hanoi đã tắt: ${account.username}`);
    }
    if (account.disabledReason === "wrong_password") {
      throw new Error(
        `Tài khoản Hanoi đã bị đánh dấu sai mật khẩu — không đăng nhập lại: ${account.username}`,
      );
    }

    const secret = env.hanoiCredentialsSecret.trim();
    if (!secret) {
      throw new Error("Thiếu HANOI_CREDENTIALS_SECRET — không thể giải mã mật khẩu");
    }
    const password = decryptHanoiPassword(account.passwordEncrypted, secret);

    trace("HANOI_AUTH", "STS password grant (API) — không dùng Chromium");
    let accessToken: string;
    try {
      accessToken = await getOrRefreshHanoiAccessToken(account, accountId, password, this.hanoiRepo, secret);
    } catch (err) {
      if (isHanoiLoginWrongCredentialsError(err)) {
        await this.hanoiRepo.markInvalidCredentials(accountId, "wrong_password");
        throw new Error(
          `Hanoi STS: sai mật khẩu hoặc tài khoản không hợp lệ — đã tắt ${account.username} (disabledReason=wrong_password).`,
        );
      }
      throw err;
    }

    trace("HANOI_USERINFO", "GET /connect/userinfo — lưu maDvql, maKhachHang, …");
    let userInfo: HanoiUserInfoSnapshot;
    try {
      userInfo = await ensureHanoiUserInfo(account, accountId, accessToken, this.hanoiRepo);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Hanoi userinfo: ${msg}`);
    }

    trace("HANOI_HOP_DONG", "GET GetDanhSachHopDongByUserName — lưu hanoi_contracts");
    try {
      const accForHop = (await this.hanoiRepo.findById(accountId)) ?? account;
      await ensureHanoiHopDongSnapshot(accForHop, accountId, accessToken, this.hanoiRepo, this.contractRepo);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[task ${traceTaskId}] Hanoi hop dong sync bỏ qua — ${msg}`);
    }

    return this.runHanoiPostAuth(task, traceTaskId, account, accountId, { accessToken, userInfo }, step);
  }

  /**
   * Đăng nhập (nếu cần) qua Playwright và lưu `storageState` — chỉ khi HANOI_USE_API_LOGIN=false.
   */
  async prepareHanoiSession(
    page: Page,
    account: HanoiAccount,
    accountId: ObjectId,
    password: string,
    traceTaskId: string,
    step: number,
  ): Promise<void> {
    const trace = (phase: string, detail?: string) => logTaskPhase(traceTaskId, phase, detail);
    trace("HANOI_ACCOUNT", account.username);

    await this.runStep("hanoi:probeSession", step, async () => {
      await page.goto(env.evnHanoiBaseUrl, { waitUntil: "domcontentloaded", timeout: step });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      await new Promise<void>((r) => setTimeout(r, 500));
    });

    await this.runStep("hanoi:dismissModalAfterProbe", step, async () => {
      await dismissHanoiOverlayIfPresent(page, step);
    });

    let loggedIn = await isHanoiLoggedIn(page);

    if (!loggedIn) {
      trace("HANOI_LOGIN", "phiên hết hạn hoặc chưa có — đăng nhập mới (Playwright)");
      try {
        await loginHanoiInteractive(
          page,
          account.username,
          password,
          (n, t, f) => this.runStep(n, t, f),
          step,
          (opts) => this.handleCaptchaWithRetry(opts),
        );
      } catch (err) {
        if (isHanoiLoginWrongCredentialsError(err)) {
          await this.hanoiRepo.markInvalidCredentials(accountId, "wrong_password");
          throw new Error(
            `Hanoi: sai mật khẩu hoặc tài khoản không hợp lệ — đã tắt tài khoản ${account.username} (disabledReason=wrong_password).`,
          );
        }
        throw err;
      }
      loggedIn = await isHanoiLoggedIn(page);
      if (!loggedIn) {
        throw new Error("Đăng nhập Hanoi: vẫn ở màn đăng nhập sau khi submit — kiểm tra credentials.");
      }
    } else {
      trace("HANOI_LOGIN", "đã có session hợp lệ (storageState)");
    }

    await this.runStep("hanoi:dismissModalAfterLogin", step, async () => {
      await dismissHanoiOverlayIfPresent(page, step);
    });

    const storage = await page.context().storageState();
    const storageJson = JSON.stringify(storage);
    await this.hanoiRepo.updateSession(accountId, storageJson, new Date());
    logger.debug(`[task ${traceTaskId}] Đã lưu storageState cho Hanoi ${account.username}`);
  }

  /**
   * Luồng đầy đủ với Playwright (fallback).
   */
  async runTask(page: Page, task: ScrapeTask, traceTaskId: string): Promise<InvoiceDownloadMetadata> {
    const step = env.hanoiStepTimeoutMs;
    const trace = (phase: string, detail?: string) => logTaskPhase(traceTaskId, phase, detail);

    const accountId = parseHanoiAccountIdFromPayload(task);
    const account = await this.hanoiRepo.findById(accountId);
    if (!account) {
      throw new Error(`Không tìm thấy hanoi_accounts._id=${accountId.toHexString()}`);
    }
    if (!account.enabled) {
      throw new Error(`Tài khoản Hanoi đã tắt: ${account.username}`);
    }
    if (account.disabledReason === "wrong_password") {
      throw new Error(
        `Tài khoản Hanoi đã bị đánh dấu sai mật khẩu — không đăng nhập lại: ${account.username}`,
      );
    }

    const secret = env.hanoiCredentialsSecret.trim();
    if (!secret) {
      throw new Error("Thiếu HANOI_CREDENTIALS_SECRET — không thể giải mã mật khẩu");
    }
    const password = decryptHanoiPassword(account.passwordEncrypted, secret);

    await this.prepareHanoiSession(page, account, accountId, password, traceTaskId, step);

    trace("HANOI_STS", "Lấy Bearer + userinfo để gọi API TraCuu (cùng luồng với Playwright)");
    let accessToken: string;
    try {
      accessToken = await getOrRefreshHanoiAccessToken(account, accountId, password, this.hanoiRepo, secret);
    } catch (err) {
      if (isHanoiLoginWrongCredentialsError(err)) {
        await this.hanoiRepo.markInvalidCredentials(accountId, "wrong_password");
        throw new Error(
          `Hanoi STS: sai mật khẩu hoặc tài khoản không hợp lệ — đã tắt ${account.username} (disabledReason=wrong_password).`,
        );
      }
      throw err;
    }
    const userInfo = await ensureHanoiUserInfo(account, accountId, accessToken, this.hanoiRepo);

    trace("HANOI_HOP_DONG", "GET GetDanhSachHopDongByUserName — lưu hanoi_contracts");
    try {
      const accForHop = (await this.hanoiRepo.findById(accountId)) ?? account;
      await ensureHanoiHopDongSnapshot(accForHop, accountId, accessToken, this.hanoiRepo, this.contractRepo);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[task ${traceTaskId}] Hanoi hop dong sync bỏ qua — ${msg}`);
    }

    return this.runHanoiPostAuth(
      task,
      traceTaskId,
      account,
      accountId,
      { page, accessToken, userInfo },
      step,
    );
  }

  /**
   * Một dòng Tra cứu — tải PDF tiền điện (TD) + tuỳ chọn GTGT (HANOI_DOWNLOAD_PAYMENT_PDF), parse và upsert DB.
   */
  private async hanoiDownloadAndParsePdfsForRow(
    traceTaskId: string,
    bearerToken: string,
    maDvql: string,
    maKh: string,
    row: HanoiDmThongTinHoaDonItem,
    kyTrongKy: 1 | 2 | 3,
    year: string,
    month: string,
    period: string,
  ): Promise<{
    tienDien: { pdfPath: string; bytes: number; parseOk: boolean; parseError?: string };
    gtgt?: { pdfPath?: string; bytes?: number; parseOk?: boolean; parseError?: string; skipped?: boolean; skipReason?: string };
  }> {
    const trace = (phase: string, detail?: string) => logTaskPhase(traceTaskId, phase, detail);
    const idHdonStr = String(row.idHdon);
    const loaiTd = (row.loaiHdon || env.hanoiPdfLoaiTienDien).trim() || "TD";

    const meta = {
      maSogcs: row.maSogcs,
      kyHieu: row.kihieuSery,
      soSery: String(row.soSery ?? ""),
      ngayPhatHanh: parseVnSlashDate(row.ngayCky || row.ngayDky),
    };

    await hanoiHumanPause(env);
    trace("HANOI_PDF_TD", `XemHoaDon loai=${loaiTd} idHdon=${idHdonStr}`);
    const bufTd = await fetchHanoiXemHoaDonPdf(bearerToken, {
      maDvql,
      maKh,
      idHoaDon: row.idHdon,
      loaiHoaDon: loaiTd,
    });
    const pdfTd = await saveHanoiInvoicePdf(
      bufTd,
      maKh.toUpperCase(),
      year,
      month,
      period,
      row.idHdon,
      "tien_dien",
    );
    const invTd = hanoiInvoiceIdSurrogateFromIdHdon(idHdonStr, "tien_dien");
    const prTd = await parseElectricityBillPdf(
      pdfTd,
      invTd,
      maKh.toUpperCase(),
      maDvql,
      meta,
      { hanoi: { idHdon: idHdonStr, kyTrongKy, pdfKind: "tien_dien" } },
    );
    if (prTd.success && prTd.bill) {
      await this.billRepo.upsert(prTd.bill);
    } else {
      await this.billRepo.markHanoiError(idHdonStr, invTd, pdfTd, prTd.error ?? "parse failed", "tien_dien");
    }

    const resultado: {
      tienDien: { pdfPath: string; bytes: number; parseOk: boolean; parseError?: string };
      gtgt?: { pdfPath?: string; bytes?: number; parseOk?: boolean; parseError?: string; skipped?: boolean; skipReason?: string };
    } = {
      tienDien: {
        pdfPath: pdfTd,
        bytes: bufTd.length,
        parseOk: Boolean(prTd.success),
        parseError: prTd.success ? undefined : prTd.error,
      },
    };

    if (!env.hanoiDownloadPaymentPdf) {
      resultado.gtgt = { skipped: true, skipReason: "HANOI_DOWNLOAD_PAYMENT_PDF=false" };
      return resultado;
    }

    const loaiGtgt = env.hanoiPdfLoaiGtgt.trim() || "GTGT";
    await hanoiHumanPause(env);
    trace("HANOI_PDF_GTGT", `XemHoaDon loai=${loaiGtgt} idHdon=${idHdonStr}`);
    try {
      const bufGt = await fetchHanoiXemHoaDonPdf(bearerToken, {
        maDvql,
        maKh,
        idHoaDon: row.idHdon,
        loaiHoaDon: loaiGtgt,
      });
      const pdfGt = await saveHanoiInvoicePdf(
        bufGt,
        maKh.toUpperCase(),
        year,
        month,
        period,
        row.idHdon,
        "gtgt",
      );
      const invGt = hanoiInvoiceIdSurrogateFromIdHdon(idHdonStr, "gtgt");
      const prGt = await parseElectricityBillPdf(
        pdfGt,
        invGt,
        maKh.toUpperCase(),
        maDvql,
        meta,
        { hanoi: { idHdon: idHdonStr, kyTrongKy, pdfKind: "gtgt" } },
      );
      if (prGt.success && prGt.bill) {
        await this.billRepo.upsert(prGt.bill);
      } else {
        await this.billRepo.markHanoiError(idHdonStr, invGt, pdfGt, prGt.error ?? "parse failed", "gtgt");
      }
      resultado.gtgt = {
        pdfPath: pdfGt,
        bytes: bufGt.length,
        parseOk: Boolean(prGt.success),
        parseError: prGt.success ? undefined : prGt.error,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[task ${traceTaskId}] Hanoi GTGT PDF bỏ qua — ${msg}`);
      resultado.gtgt = { skipped: true, skipReason: msg };
    }

    return resultado;
  }

  private async runHanoiPostAuth(
    task: ScrapeTask,
    traceTaskId: string,
    account: HanoiAccount,
    accountId: ObjectId,
    auth:
      | { accessToken: string; userInfo: HanoiUserInfoSnapshot }
      | { page: Page; accessToken: string; userInfo: HanoiUserInfoSnapshot },
    step: number,
  ): Promise<InvoiceDownloadMetadata> {
    const trace = (phase: string, detail?: string) => logTaskPhase(traceTaskId, phase, detail);

    const userInfo = auth.userInfo ?? account.userInfo ?? undefined;
    const bearerToken = auth.accessToken;

    if (task.payload.kind === "online_payment_link") {
      const rawMa =
        typeof task.payload.maKhachHang === "string" ? task.payload.maKhachHang.trim() : "";
      const maKh = (rawMa || account.username).trim().toUpperCase();
      trace("HANOI_ONLINE_PAYMENT", `Tra cứu link thanh toán ma=${maKh}`);
      await hanoiHumanPause(env);

      let onlinePaymentLink: HanoiOnlinePaymentLinkResult;
      if ("page" in auth) {
        onlinePaymentLink = await fetchHanoiOnlinePaymentLink(maKh, step, {
          accessToken: bearerToken,
          page: auth.page,
        });
        const storage2 = await auth.page.context().storageState();
        await this.hanoiRepo.updateSession(accountId, JSON.stringify(storage2), new Date());
      } else {
        onlinePaymentLink = await fetchHanoiOnlinePaymentLink(maKh, step, {
          accessToken: bearerToken,
        });
      }

      return {
        downloadedAt: new Date().toISOString(),
        lookupPayload: {
          provider: "EVN_HANOI",
          hanoiAccountId: accountId.toHexString(),
          username: account.username,
          authMode: "page" in auth ? "browser" : "api",
          ...(userInfo !== undefined ? { userInfo } : {}),
          onlinePaymentLink: onlinePaymentLink as unknown as Record<string, unknown>,
        },
      };
    }

    const periodStr = String(task.payload.period ?? task.payload.ky ?? "1");
    const kyNum = Math.max(1, Math.min(3, Number.parseInt(periodStr, 10) || 1));
    const monthRaw = task.payload.month ?? task.payload.thang ?? String(new Date().getMonth() + 1);
    const monthNum = Number.parseInt(String(monthRaw), 10);
    if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) {
      throw new Error(`Hanoi task: tháng không hợp lệ — ${String(monthRaw)}`);
    }
    const yearRaw = task.payload.year ?? task.payload.nam ?? new Date().getFullYear();
    const yearNum =
      typeof yearRaw === "number" && Number.isFinite(yearRaw)
        ? yearRaw
        : Number.parseInt(String(yearRaw), 10);
    if (!Number.isFinite(yearNum) || yearNum < 2000 || yearNum > 2100) {
      throw new Error(`Hanoi task: năm không hợp lệ — ${String(yearRaw)}`);
    }

    const month = String(monthNum).padStart(2, "0");
    const year = String(yearNum);
    const period = String(kyNum);

    trace("HANOI_PERIOD", `Kỳ ${period} tháng ${month} năm ${year}`);

    const maDvql = userInfo?.maDvql?.trim();
    const maKh = userInfo?.maKhachHang?.trim();
    if (!maDvql || !maKh) {
      throw new Error(
        "Hanoi TraCuu: thiếu maDvql hoặc maKhachHang trong userinfo — kiểm tra GET /connect/userinfo.",
      );
    }

    await hanoiHumanPause(env);
    trace("HANOI_TRACUU", "GET /api/TraCuu/GetThongTinHoaDon");

    const traCuuResp = await fetchHanoiGetThongTinHoaDon(bearerToken, {
      maDvql,
      maKh,
      thang: monthNum,
      nam: yearNum,
      ky: kyNum,
    });

    const allRows = traCuuResp.data?.dmThongTinHoaDonList ?? [];
    const requested = { ky: kyNum, thang: monthNum, nam: yearNum };
    const matchedRows = filterHanoiThongTinRowsForPeriod(allRows, requested);
    const kysInResponse = distinctKyInRows(allRows);

    const downloadedAt = new Date().toISOString();

    if (matchedRows.length === 0) {
      return {
        downloadedAt,
        lookupPayload: {
          provider: "EVN_HANOI",
          hanoiAccountId: accountId.toHexString(),
          username: account.username,
          authMode: "page" in auth ? "browser" : "api",
          ...(userInfo !== undefined ? { userInfo } : {}),
          period,
          month,
          year,
          hanoiTraCuu: {
            requested: requested,
            responseCode: traCuuResp.code ?? null,
            rows: allRows,
            rowCount: allRows.length,
            distinctKyInMonth: kysInResponse,
            matchedCount: 0,
            matchedForRequestedKy: [],
            idHdonList: [],
          },
          note:
            "GetThongTinHoaDon: không có dòng khớp ky/tháng/năm — không tải PDF.",
        },
      };
    }

    const kyTrongKy = kyNum as 1 | 2 | 3;
    let pdfAttempted = 0;
    let pdfSuccess = 0;
    let parseAttempted = 0;
    let parseSuccess = 0;
    const hanoiPdfDetails: Array<Record<string, unknown>> = [];

    for (const row of matchedRows) {
      const batch = await this.hanoiDownloadAndParsePdfsForRow(
        traceTaskId,
        bearerToken,
        maDvql,
        maKh,
        row,
        kyTrongKy,
        year,
        month,
        period,
      );
      pdfAttempted += 1;
      pdfSuccess += 1;
      parseAttempted += 1;
      if (batch.tienDien.parseOk) parseSuccess += 1;
      hanoiPdfDetails.push({
        idHdon: row.idHdon,
        tienDien: batch.tienDien,
      });

      if (batch.gtgt && !batch.gtgt.skipped) {
        pdfAttempted += 1;
        if (batch.gtgt.pdfPath) pdfSuccess += 1;
        parseAttempted += 1;
        if (batch.gtgt.parseOk) parseSuccess += 1;
        (hanoiPdfDetails[hanoiPdfDetails.length - 1] as Record<string, unknown>).gtgt = batch.gtgt;
      } else if (batch.gtgt?.skipped) {
        (hanoiPdfDetails[hanoiPdfDetails.length - 1] as Record<string, unknown>).gtgt = batch.gtgt;
      }
    }

    return {
      downloadedAt,
      pdfSync:
        pdfAttempted > 0
          ? {
              attempted: pdfAttempted,
              success: pdfSuccess,
              failed: pdfAttempted - pdfSuccess,
              failedIds: [],
            }
          : undefined,
      parseSync:
        parseAttempted > 0
          ? {
              attempted: parseAttempted,
              success: parseSuccess,
              failed: parseAttempted - parseSuccess,
            }
          : undefined,
      lookupPayload: {
        provider: "EVN_HANOI",
        hanoiAccountId: accountId.toHexString(),
        username: account.username,
        authMode: "page" in auth ? "browser" : "api",
        ...(userInfo !== undefined ? { userInfo } : {}),
        period,
        month,
        year,
        hanoiTraCuu: {
          requested: requested,
          responseCode: traCuuResp.code ?? null,
          rows: allRows,
          rowCount: allRows.length,
          distinctKyInMonth: kysInResponse,
          matchedCount: matchedRows.length,
          matchedForRequestedKy: matchedRows,
          idHdonList: matchedRows.map((r) => r.idHdon),
        },
        hanoiPdf: hanoiPdfDetails,
        note: "Đã tải PDF (tiền điện + GTGT nếu bật HANOI_DOWNLOAD_PAYMENT_PDF), parse và upsert electricity_bills (provider=EVN_HANOI).",
      },
    };
  }
}
