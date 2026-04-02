import type { Page } from "playwright";
import { BaseWorker } from "../../core/BaseWorker.js";
import { env } from "../../config/env.js";
import type { InvoiceDownloadMetadata, ScrapeTask } from "../../types/task.js";
import { HanoiAccountRepository } from "../../db/hanoiAccountRepository.js";
import { decryptHanoiPassword } from "../../services/crypto/hanoiCredentials.js";
import {
  dismissHanoiOverlayIfPresent,
  isOnHanoiLoginPage,
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
  dedupeHanoiDmThongTinByIdHdon,
  distinctKyInRows,
  fetchHanoiGetThongTinHoaDon,
  filterHanoiThongTinRowsForMonth,
} from "../../services/hanoi/hanoiGetThongTinHoaDonClient.js";
import type { ObjectId } from "mongodb";
import type { HanoiAccount } from "../../types/hanoiAccount.js";
import type { HanoiUserInfoSnapshot } from "../../types/hanoiUserInfo.js";
import type { HanoiDmThongTinHoaDonItem } from "../../types/hanoiGetThongTinHoaDon.js";
import type { HanoiContract } from "../../types/hanoiHopDong.js";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import { effectiveMaKhachHangForBills } from "../../services/hanoi/hanoiResolveAccount.js";
import { parseElectricityBillPdf } from "../../services/pdf/ElectricityBillParser.js";
import { fetchHanoiXemHoaDonPdf } from "../../services/hanoi/hanoiXemHoaDonPdfClient.js";
import { saveHanoiInvoicePdf } from "../../services/hanoi/saveHanoiInvoicePdf.js";
import { hanoiInvoiceIdSurrogateFromIdHdon } from "../../services/hanoi/hanoiElectricityBillId.js";

function parseVnSlashDate(s: string): Date {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return new Date();
  return new Date(`${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}T12:00:00.000Z`);
}

/** `ky` trên dòng API → 1|2|3 (parse lỗi → 1). */
function hanoiKyFromRow(row: HanoiDmThongTinHoaDonItem): 1 | 2 | 3 {
  const k = Number(row.ky);
  if (k === 1 || k === 2 || k === 3) return k;
  return 1;
}

/** Kỳ trong tháng từ payload task (`period` hoặc `ky`) — thiếu = quét cả 3 kỳ URL. */
function parseRequestedPeriodKyFromPayload(payload: Record<string, unknown>): 1 | 2 | 3 | null {
  const raw = payload.period ?? payload.ky;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (n === 1 || n === 2 || n === 3) return n;
  return null;
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
      // Mở thẳng trang đăng nhập — không dừng ở trang chủ rồi nhầm là đã đăng nhập
      await page.goto(env.evnHanoiLoginUrl, { waitUntil: "domcontentloaded", timeout: step });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
      await new Promise<void>((r) => setTimeout(r, 500));
    });

    await this.runStep("hanoi:dismissModalAfterProbe", step, async () => {
      await dismissHanoiOverlayIfPresent(page, step);
    });

    // Còn ở URL /user/login → chưa có session; redirect ra khỏi login (đã cookie) → bỏ qua form
    let loggedIn = !(await isOnHanoiLoginPage(page));

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
      if (await isOnHanoiLoginPage(page)) {
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
   * Cặp `(maDvql, maKh)` cho GET GetThongTinHoaDon — lấy từ `hanoi_contracts` (API hợp đồng: `maDonViQuanLy` + `maKhachHang`).
   * Fallback: một cặp từ userinfo nếu chưa có hợp đồng trong DB.
   */
  private collectHanoiTraCuuPairsFromContracts(
    contracts: HanoiContract[],
    userInfo: HanoiUserInfoSnapshot | undefined,
  ): Array<{ maDvql: string; maKh: string }> {
    const map = new Map<string, { maDvql: string; maKh: string }>();
    for (const c of contracts) {
      const dv = (c.normalized.maDvql ?? String(c.raw["maDonViQuanLy"] ?? "")).trim();
      const kh = c.maKhachHang?.trim().toUpperCase();
      if (!dv || !kh) continue;
      map.set(`${dv}|${kh}`, { maDvql: dv, maKh: kh });
    }
    if (map.size === 0 && userInfo?.maDvql?.trim() && userInfo.maKhachHang?.trim()) {
      const dv = userInfo.maDvql.trim();
      const kh = userInfo.maKhachHang.trim().toUpperCase();
      map.set(`${dv}|${kh}`, { maDvql: dv, maKh: kh });
    }
    return [...map.values()].sort(
      (a, b) => a.maDvql.localeCompare(b.maDvql, "vi") || a.maKh.localeCompare(b.maKh, "vi"),
    );
  }

  /**
   * Một dòng Tra cứu — GET XemHoaDon trả **một PDF** (base64) chứa cả thông báo tiền điện và GTGT; lưu một file,
   * parse hai lần (`tien_dien` / `gtgt`) trên cùng `pdfPath` nếu bật HANOI_DOWNLOAD_PAYMENT_PDF.
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
    const maDvqlPdf = (row.maDonViQuanLy ?? maDvql).trim();
    const maKhPdf = (row.maKhang ?? maKh).trim();
    const idHdonStr = String(row.idHdon);
    const loaiTd = (row.loaiHdon || env.hanoiPdfLoaiTienDien).trim() || "TD";

    const meta = {
      maSogcs: row.maSogcs,
      kyHieu: row.kihieuSery,
      soSery: String(row.soSery ?? ""),
      ngayPhatHanh: parseVnSlashDate(row.ngayCky || row.ngayDky),
    };

    await hanoiHumanPause(env);
    trace(
      "HANOI_PDF",
      `XemHoaDon loai=${loaiTd} idHdon=${idHdonStr} — một PDF (TB tiền điện + GTGT trong cùng file)`,
    );
    const buf = await fetchHanoiXemHoaDonPdf(bearerToken, {
      maDvql: maDvqlPdf,
      maKh: maKhPdf,
      idHoaDon: row.idHdon,
      loaiHoaDon: loaiTd,
    });

    const pdfPath = await saveHanoiInvoicePdf(
      buf,
      maKhPdf.toUpperCase(),
      year,
      month,
      period,
      row.idHdon,
      "xem_hoa_don",
    );

    const invTd = hanoiInvoiceIdSurrogateFromIdHdon(idHdonStr, "tien_dien");
    const prTd = await parseElectricityBillPdf(
      pdfPath,
      invTd,
      maKhPdf.toUpperCase(),
      maDvqlPdf,
      meta,
      { hanoi: { idHdon: idHdonStr, kyTrongKy, pdfKind: "tien_dien" } },
    );
    if (prTd.success && prTd.bill) {
      await this.billRepo.upsert(prTd.bill);
    } else {
      await this.billRepo.markHanoiError(idHdonStr, invTd, pdfPath, prTd.error ?? "parse failed", "tien_dien");
    }

    const resultado: {
      tienDien: { pdfPath: string; bytes: number; parseOk: boolean; parseError?: string };
      gtgt?: { pdfPath?: string; bytes?: number; parseOk?: boolean; parseError?: string; skipped?: boolean; skipReason?: string };
    } = {
      tienDien: {
        pdfPath: pdfPath,
        bytes: buf.length,
        parseOk: Boolean(prTd.success),
        parseError: prTd.success ? undefined : prTd.error,
      },
    };

    if (!env.hanoiDownloadPaymentPdf) {
      resultado.gtgt = { skipped: true, skipReason: "HANOI_DOWNLOAD_PAYMENT_PDF=false" };
      return resultado;
    }

    trace("HANOI_PDF_GTGT", `parse GTGT trên cùng file idHdon=${idHdonStr}`);
    try {
      const invGt = hanoiInvoiceIdSurrogateFromIdHdon(idHdonStr, "gtgt");
      const prGt = await parseElectricityBillPdf(
        pdfPath,
        invGt,
        maKhPdf.toUpperCase(),
        maDvqlPdf,
        meta,
        { hanoi: { idHdon: idHdonStr, kyTrongKy, pdfKind: "gtgt" } },
      );
      if (prGt.success && prGt.bill) {
        await this.billRepo.upsert(prGt.bill);
      } else {
        await this.billRepo.markHanoiError(idHdonStr, invGt, pdfPath, prGt.error ?? "parse failed", "gtgt");
      }
      resultado.gtgt = {
        pdfPath: pdfPath,
        bytes: buf.length,
        parseOk: Boolean(prGt.success),
        parseError: prGt.success ? undefined : prGt.error,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[task ${traceTaskId}] Hanoi GTGT parse bỏ qua — ${msg}`);
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
      const maKh = effectiveMaKhachHangForBills(rawMa || undefined, account);
      trace("HANOI_ONLINE_PAYMENT", `Tra cứu link thanh toán ma=${maKh}`);
      await hanoiHumanPause(env);

      const maDViQLy = userInfo?.maDvql;
      let onlinePaymentLink: HanoiOnlinePaymentLinkResult;
      if ("page" in auth) {
        onlinePaymentLink = await fetchHanoiOnlinePaymentLink(maKh, step, {
          accessToken: bearerToken,
          page: auth.page,
          maDViQLy,
        });
        const storage2 = await auth.page.context().storageState();
        await this.hanoiRepo.updateSession(accountId, JSON.stringify(storage2), new Date());
      } else {
        onlinePaymentLink = await fetchHanoiOnlinePaymentLink(maKh, step, {
          accessToken: bearerToken,
          maDViQLy,
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

    const requestedPeriodKy = parseRequestedPeriodKyFromPayload(task.payload as Record<string, unknown>);
    const kyUrlsToScan: readonly number[] =
      requestedPeriodKy != null ? [requestedPeriodKy] : [1, 2, 3];

    trace(
      "HANOI_PERIOD",
      requestedPeriodKy != null
        ? `Tháng ${month}/${year} — chỉ kỳ ${requestedPeriodKy} (theo payload)`
        : `Tháng ${month}/${year} — quét mọi kỳ (1–3) trong tháng`,
    );

    const contracts = await this.contractRepo.findByAccountId(accountId);
    let traCuuPairs = this.collectHanoiTraCuuPairsFromContracts(contracts, userInfo);
    if (traCuuPairs.length === 0) {
      throw new Error(
        "Hanoi TraCuu: không có cặp (maDonViQuanLy, maKhachHang) — đồng bộ GetDanhSachHopDongByUserName hoặc kiểm tra GET /connect/userinfo.",
      );
    }

    const requestedMaKh =
      typeof task.payload.maKhachHang === "string" ? task.payload.maKhachHang.trim().toUpperCase() : "";
    if (requestedMaKh) {
      const before = traCuuPairs.length;
      traCuuPairs = traCuuPairs.filter((p) => p.maKh === requestedMaKh);
      if (traCuuPairs.length === 0) {
        throw new Error(
          `Hanoi TraCuu: mã khách hàng ${requestedMaKh} không có trong hợp đồng/userinfo của tài khoản (có ${before} mã khác).`,
        );
      }
      trace(
        "HANOI_TRACUU_FILTER",
        `Lọc theo payload.maKhachHang=${requestedMaKh} → ${traCuuPairs.length} cặp (trước đó ${before})`,
      );
    }

    trace(
      "HANOI_TRACUU",
      `GET GetThongTinHoaDon — ${traCuuPairs.length} cặp (maDvql,maKh) từ hợp đồng / userinfo`,
    );

    const requestedMonth = { thang: monthNum, nam: yearNum };
    const traCuuByPair: Array<{
      maDvql: string;
      maKh: string;
      kyCalls: Array<{ kyUrl: number; responseCode: number | null; rowCount: number; error?: string }>;
      mergedRowCount: number;
    }> = [];
    const allRows: HanoiDmThongTinHoaDonItem[] = [];

    for (let i = 0; i < traCuuPairs.length; i++) {
      const { maDvql: md, maKh: mk } = traCuuPairs[i]!;
      await hanoiHumanPause(env);
      const mergedFromPair: HanoiDmThongTinHoaDonItem[] = [];
      const kyCalls: Array<{ kyUrl: number; responseCode: number | null; rowCount: number; error?: string }> = [];
      for (const kyUrl of kyUrlsToScan) {
        if (kyUrl > 1) await hanoiHumanPause(env);
        try {
          const traCuuResp = await fetchHanoiGetThongTinHoaDon(bearerToken, {
            maDvql: md,
            maKh: mk,
            thang: monthNum,
            nam: yearNum,
            ky: kyUrl,
          });
          const list = traCuuResp.data?.dmThongTinHoaDonList ?? [];
          mergedFromPair.push(...list);
          kyCalls.push({
            kyUrl,
            responseCode: traCuuResp.code ?? null,
            rowCount: list.length,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.warn(`[task ${traceTaskId}] GetThongTinHoaDon maDvql=${md} maKh=${mk} ky=${kyUrl} — ${msg}`);
          kyCalls.push({ kyUrl, responseCode: null, rowCount: 0, error: msg.slice(0, 500) });
        }
      }
      const forMonth = dedupeHanoiDmThongTinByIdHdon(
        filterHanoiThongTinRowsForMonth(mergedFromPair, requestedMonth),
      );
      allRows.push(...forMonth);
      traCuuByPair.push({
        maDvql: md,
        maKh: mk,
        kyCalls,
        mergedRowCount: forMonth.length,
      });
    }

    const monthRows = dedupeHanoiDmThongTinByIdHdon(
      filterHanoiThongTinRowsForMonth(allRows, requestedMonth),
    );
    const rowsForPdf =
      requestedPeriodKy != null
        ? monthRows.filter((r) => hanoiKyFromRow(r) === requestedPeriodKy)
        : monthRows;
    if (requestedPeriodKy != null && monthRows.length > 0 && rowsForPdf.length === 0) {
      trace(
        "HANOI_KY_FILTER",
        `Không có dòng kỳ ${requestedPeriodKy} trong tháng (có ${monthRows.length} dòng kỳ khác).`,
      );
    }
    const kysInResponse = distinctKyInRows(allRows);

    const downloadedAt = new Date().toISOString();

    if (rowsForPdf.length === 0) {
      return {
        downloadedAt,
        lookupPayload: {
          provider: "EVN_HANOI",
          hanoiAccountId: accountId.toHexString(),
          username: account.username,
          authMode: "page" in auth ? "browser" : "api",
          ...(userInfo !== undefined ? { userInfo } : {}),
          month,
          year,
          requestedPeriodKy: requestedPeriodKy ?? null,
          scanAllKyInMonth: requestedPeriodKy == null,
          hanoiTraCuu: {
            requestedMonth,
            traCuuPairs: traCuuByPair,
            contractPairCount: traCuuPairs.length,
            rows: allRows,
            rowCount: allRows.length,
            distinctKyInMonth: kysInResponse,
            matchedCount: 0,
            matchedRowsInMonth: [],
            idHdonList: [],
          },
          note:
            "GetThongTinHoaDon: không có dòng khớp tháng/năm (và kỳ yêu cầu nếu có) — không tải PDF.",
        },
      };
    }

    const fbPair = traCuuPairs[0]!;
    let pdfAttempted = 0;
    let pdfSuccess = 0;
    let parseAttempted = 0;
    let parseSuccess = 0;
    const hanoiPdfDetails: Array<Record<string, unknown>> = [];

    for (const row of rowsForPdf) {
      const kyTrongKy = hanoiKyFromRow(row);
      const periodForFile = String(kyTrongKy);
      const batch = await this.hanoiDownloadAndParsePdfsForRow(
        traceTaskId,
        bearerToken,
        row.maDonViQuanLy?.trim() || fbPair.maDvql,
        row.maKhang?.trim() || fbPair.maKh,
        row,
        kyTrongKy,
        year,
        month,
        periodForFile,
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
        month,
        year,
        requestedPeriodKy: requestedPeriodKy ?? null,
        scanAllKyInMonth: requestedPeriodKy == null,
        hanoiTraCuu: {
          requestedMonth,
          traCuuPairs: traCuuByPair,
          contractPairCount: traCuuPairs.length,
          rows: allRows,
          rowCount: allRows.length,
          distinctKyInMonth: kysInResponse,
          matchedCount: rowsForPdf.length,
          matchedRowsInMonth: rowsForPdf,
          idHdonList: rowsForPdf.map((r) => r.idHdon),
        },
        hanoiPdf: hanoiPdfDetails,
        note:
          requestedPeriodKy != null
            ? `Chỉ xử lý kỳ ${requestedPeriodKy} theo payload (mỗi idHdon: GET XemHoaDon → PDF, parse TD/GTGT nếu bật).`
            : "Quét kỳ 1–3 trên URL; mỗi idHdon: GET XemHoaDon → PDF (TB+GTGT cùng file nếu bật HANOI_DOWNLOAD_PAYMENT_PDF).",
      },
    };
  }
}
