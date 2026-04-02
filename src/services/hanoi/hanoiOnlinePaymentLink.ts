import type { Page } from "playwright";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import type { HanoiContract } from "../../types/hanoiHopDong.js";
import { buildHanoiApiAuthHeaders } from "./hanoiApiHeaders.js";

/**
 * API `GetListThongTinNoKhachHang` bắt buộc đúng **mã đơn vị quản lý** của mã khách hàng đó.
 * `userinfo.maDvql` chỉ phản ánh một ngữ cảnh (thường là hợp đồng mặc định); khi một tài khoản
 * quản lý **nhiều** mã KH thuộc **nhiều** đơn vị, phải lấy `maDonViQuanLy` / `maDvql` từ dòng
 * `hanoi_contracts` trùng `maKhachHang`.
 */
export function resolveMaDViQLyForOnlinePayment(
  contract: HanoiContract | null | undefined,
  userInfoMaDvql: string | undefined,
): string | undefined {
  const fromNorm = contract?.normalized?.maDvql?.trim();
  if (fromNorm) return fromNorm;
  const raw = contract?.raw;
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const v = r.maDonViQuanLy ?? r.maDvql ?? r.maDViQLy;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const u = userInfoMaDvql?.trim();
  return u || undefined;
}

/**
 * Kết quả lấy link thanh toán EVN Hà Nội.
 */
export type HanoiOnlinePaymentLinkResult =
  | {
      ok: true;
      paymentUrl: string;
      maKhachHang: string;
      httpStatus: number;
    }
  | {
      ok: false;
      reason: string;
      code: HanoiOnlinePaymentLinkErrorCode;
      maKhachHang: string;
      httpStatus?: number;
      bodyPreview?: string;
    };

export type HanoiOnlinePaymentLinkErrorCode =
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "API_BUSINESS_ERROR"
  | "EMPTY_DEBT_LIST"
  | "NO_PAYMENT_URL"
  | "EMPTY_RESPONSE"
  | "MISSING_MA_DVQL"
  | "NO_AUTH_CONTEXT";

function fail(
  code: HanoiOnlinePaymentLinkErrorCode,
  reason: string,
  maKhachHang: string,
  extra?: { httpStatus?: number; bodyPreview?: string },
): HanoiOnlinePaymentLinkResult {
  return { ok: false, code, reason, maKhachHang, ...extra };
}

/** Trang EVN HN mà API thanh toán tham chiếu (Referer). */
function hanoiPaymentReferer(): string {
  const base = env.evnHanoiBaseUrl.replace(/\/$/, "");
  return `${base}/dashboard/home/quan-ly-hoa-don/thanh-toan-tien-dien-va-hoa-don-dich-vu`;
}

function tracuuNoKhachHangUrl(): string {
  return `${env.evnHanoiBaseUrl.replace(/\/$/, "")}/api/TraCuu/GetListThongTinNoKhachHang`;
}

type TracuuNoVm = {
  urlThanhToan?: string;
  loaiHoaDon?: string;
};

function rowPaymentUrl(r: TracuuNoVm): string | undefined {
  const rec = r as Record<string, unknown>;
  const a = typeof r.urlThanhToan === "string" ? r.urlThanhToan.trim() : "";
  const b = typeof rec.UrlThanhToan === "string" ? String(rec.UrlThanhToan).trim() : "";
  const u = a || b;
  return u || undefined;
}

function loaiMatchesTd(loai: unknown): boolean {
  if (typeof loai !== "string") return false;
  const s = loai.trim().toUpperCase();
  return s === "TD" || s === "TIỀN ĐIỆN" || s.includes("TIỀN ĐIỆN");
}

function extractDebtListVm(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const o = data as Record<string, unknown>;
  const keys = [
    "listThongTinNoKhachHangVm",
    "listThongTinNoKhachHang",
    "ListThongTinNoKhachHangVm",
    "thongTinNoKhachHangVms",
  ];
  for (const k of keys) {
    if (k in o) return o[k];
  }
  return undefined;
}

/** Gộp các biến thể JSON EVN: `data` là mảng, hoặc object có list*, hoặc list ở root. */
function extractDebtListFromResponse(root: Record<string, unknown>): unknown {
  const data = root.data;
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const fromVm = extractDebtListVm(data);
    if (fromVm !== undefined) return fromVm;
  }
  return extractDebtListVm(root);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickUrlThanhToan(list: unknown): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const rows = list.filter((x): x is TracuuNoVm => x !== null && typeof x === "object");
  const td = rows.find((r) => loaiMatchesTd(r.loaiHoaDon) && rowPaymentUrl(r));
  if (td) return rowPaymentUrl(td) ?? null;
  const strictTd = rows.find((r) => String(r.loaiHoaDon ?? "").trim().toUpperCase() === "TD" && rowPaymentUrl(r));
  if (strictTd) return rowPaymentUrl(strictTd) ?? null;
  const any = rows.find((r) => rowPaymentUrl(r));
  return any ? rowPaymentUrl(any) ?? null : null;
}

/**
 * Một lần POST `/api/TraCuu/GetListThongTinNoKhachHang`.
 */
async function fetchPaymentUrlFromTracuuApiOnce(args: {
  accessToken: string;
  maDViQLy: string;
  maKhachHang: string;
  timeoutMs: number;
}): Promise<
  | { ok: true; paymentUrl: string; httpStatus: number }
  | { ok: false; httpStatus: number; reason: string; bodyPreview?: string; code: HanoiOnlinePaymentLinkErrorCode }
> {
  const timeoutMs = Math.max(5_000, args.timeoutMs);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let httpStatus = 0;
  try {
    const res = await fetch(tracuuNoKhachHangUrl(), {
      method: "POST",
      headers: {
        ...buildHanoiApiAuthHeaders(args.accessToken, hanoiPaymentReferer()),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        maDViQLy: args.maDViQLy.trim(),
        maKhachHang: args.maKhachHang.trim().toUpperCase(),
      }),
      signal: controller.signal,
    });
    httpStatus = res.status;
    const text = await res.text().catch(() => "");

    if (!res.ok) {
      return {
        ok: false,
        httpStatus,
        reason: `HTTP ${httpStatus} — ${res.statusText || "lỗi"}`,
        bodyPreview: text.slice(0, 500),
        code: "HTTP_ERROR",
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        httpStatus,
        reason: "Phản hồi không phải JSON hợp lệ",
        bodyPreview: text.slice(0, 400),
        code: "INVALID_JSON",
      };
    }

    const root = json as Record<string, unknown>;
    if (root.isError === true) {
      const msg =
        typeof root.message === "string" && root.message.trim()
          ? root.message.trim()
          : "API báo isError=true";
      return { ok: false, httpStatus, reason: msg, code: "API_BUSINESS_ERROR" };
    }
    if (typeof root.code === "number" && root.code !== 0) {
      const msg =
        typeof root.message === "string" && root.message.trim()
          ? root.message.trim()
          : `Mã lỗi nghiệp vụ code=${root.code}`;
      return { ok: false, httpStatus, reason: msg, code: "API_BUSINESS_ERROR" };
    }

    const list = extractDebtListFromResponse(root);

    const paymentUrl = pickUrlThanhToan(list);
    if (!paymentUrl) {
      const empty = !Array.isArray(list) || list.length === 0;
      return {
        ok: false,
        httpStatus,
        reason: empty
          ? "Không có khoản nợ (danh sách trống) hoặc chưa phát sinh nợ — kiểm tra maDViQLy đúng đơn vị của mã KH (hanoi_contracts)."
          : "Phản hồi không chứa urlThanhToan hợp lệ.",
        bodyPreview: text.slice(0, 400),
        code: empty ? "EMPTY_DEBT_LIST" : "NO_PAYMENT_URL",
      };
    }

    logger.info(
      `[hanoi-online-payment] OK ma=${args.maKhachHang} urlLen=${paymentUrl.length} HTTP ${httpStatus}`,
    );
    return { ok: true, paymentUrl, httpStatus };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = msg.includes("abort") || msg.includes("Abort");
    return {
      ok: false,
      httpStatus,
      reason: aborted ? `Hết thời gian chờ API (${timeoutMs}ms)` : msg,
      code: "HTTP_ERROR",
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Gọi Tra cứu nợ + URL thanh toán; **retry** khi HTTP 200 nhưng list trống / thiếu URL (EVN đôi khi trả tạm rỗng khi gọi dày).
 */
async function fetchPaymentUrlFromTracuuApi(args: {
  accessToken: string;
  maDViQLy: string;
  maKhachHang: string;
  timeoutMs: number;
}): Promise<
  | { ok: true; paymentUrl: string; httpStatus: number }
  | { ok: false; httpStatus: number; reason: string; bodyPreview?: string; code: HanoiOnlinePaymentLinkErrorCode }
> {
  const maxExtra = env.hanoiOnlinePaymentTracuuMaxRetries;
  const totalAttempts = 1 + maxExtra;
  const baseDelay = env.hanoiOnlinePaymentTracuuRetryDelayMs;
  const preMs = env.hanoiOnlinePaymentTracuuPreDelayMs;
  if (preMs > 0) {
    logger.info(
      `[hanoi-online-payment] Chờ ${preMs}ms trước Tra cứu nợ (tránh gọi API chồng khi phiên/web EVN HN còn tải) — ma=${args.maKhachHang}`,
    );
    await sleep(preMs);
  }

  let last: Awaited<ReturnType<typeof fetchPaymentUrlFromTracuuApiOnce>> | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    last = await fetchPaymentUrlFromTracuuApiOnce(args);
    if (last.ok) return last;

    const retryable =
      last.httpStatus === 200 &&
      (last.code === "EMPTY_DEBT_LIST" || last.code === "NO_PAYMENT_URL");
    if (!retryable || attempt >= totalAttempts) {
      logger.warn(
        `[hanoi-online-payment] FAIL ma=${args.maKhachHang} maDViQLy=${args.maDViQLy} code=${last.code} HTTP ${last.httpStatus} (sau ${attempt} lần gọi)`,
      );
      return last;
    }

    const jitter = Math.floor(Math.random() * 450);
    const wait = baseDelay * attempt + jitter;
    logger.info(
      `[hanoi-online-payment] ${last.code} lần ${attempt}/${totalAttempts} — chờ ${wait}ms rồi gọi lại (thống nhất tham số; API đôi khi trả rỗng khi gọi liên tiếp)`,
    );
    await sleep(wait);
  }

  return last!;
}

/**
 * Lấy link thanh toán EVN Hà Nội qua API REST (sau Bearer STS).
 *
 * - **API**: `accessToken` + `maDViQLy` (mã ĐVQL từ userinfo, vd. HN0100).
 * - `page` chỉ còn để tương thích chữ ký — luồng thực tế dùng Bearer từ STS.
 */
export async function fetchHanoiOnlinePaymentLink(
  maKhachHang: string,
  step: number,
  opts: { accessToken?: string; page?: Page; maDViQLy?: string },
): Promise<HanoiOnlinePaymentLinkResult> {
  void opts.page;
  const ma = maKhachHang.trim().toUpperCase();
  if (!ma) {
    return fail("EMPTY_RESPONSE", "Thiếu mã khách hàng", "");
  }

  if (!opts.accessToken?.trim()) {
    return fail("NO_AUTH_CONTEXT", "Cần accessToken (Bearer STS) để gọi API thanh toán.", ma);
  }

  const maDViQLy = opts.maDViQLy?.trim();
  if (!maDViQLy) {
    return fail(
      "MISSING_MA_DVQL",
      "Thiếu maDViQLy (mã đơn vị quản lý) — cần GET /connect/userinfo thành công (claim maDvql).",
      ma,
    );
  }

  const r = await fetchPaymentUrlFromTracuuApi({
    accessToken: opts.accessToken.trim(),
    maDViQLy,
    maKhachHang: ma,
    timeoutMs: step,
  });

  if (r.ok) {
    return {
      ok: true,
      paymentUrl: r.paymentUrl,
      maKhachHang: ma,
      httpStatus: r.httpStatus,
    };
  }

  return fail(r.code, r.reason, ma, { httpStatus: r.httpStatus, bodyPreview: r.bodyPreview });
}
