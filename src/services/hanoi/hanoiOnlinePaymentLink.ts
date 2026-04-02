import type { Page } from "playwright";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { buildHanoiApiAuthHeaders } from "./hanoiApiHeaders.js";

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

function pickUrlThanhToan(list: unknown): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const rows = list.filter((x): x is TracuuNoVm => x !== null && typeof x === "object");
  const td = rows.find((r) => r.loaiHoaDon === "TD" && typeof r.urlThanhToan === "string" && r.urlThanhToan.trim());
  if (td?.urlThanhToan) return td.urlThanhToan.trim();
  const any = rows.find((r) => typeof r.urlThanhToan === "string" && r.urlThanhToan.trim());
  return any?.urlThanhToan?.trim() ?? null;
}

/**
 * POST `/api/TraCuu/GetListThongTinNoKhachHang` — Bearer + `{ maDViQLy, maKhachHang }`.
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

    const data = root.data;
    const list =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).listThongTinNoKhachHangVm
        : undefined;

    const paymentUrl = pickUrlThanhToan(list);
    if (!paymentUrl) {
      return {
        ok: false,
        httpStatus,
        reason:
          !Array.isArray(list) || list.length === 0
            ? "Không có khoản nợ (danh sách trống) hoặc chưa phát sinh nợ."
            : "Phản hồi không chứa urlThanhToan hợp lệ.",
        bodyPreview: text.slice(0, 400),
        code: !Array.isArray(list) || list.length === 0 ? "EMPTY_DEBT_LIST" : "NO_PAYMENT_URL",
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
