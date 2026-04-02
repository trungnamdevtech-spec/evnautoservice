import type { Page } from "playwright";
import { logger } from "../../core/logger.js";

/**
 * Kết quả lấy link thanh toán EVN Hà Nội.
 * Sẽ được bổ sung chi tiết khi có thông tin endpoint từ hệ thống sau đăng nhập.
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
  | "NO_PAYMENT_LINK_IN_HTML"
  | "EMPTY_RESPONSE"
  | "NOT_IMPLEMENTED"
  | "NO_AUTH_CONTEXT";

function fail(
  code: HanoiOnlinePaymentLinkErrorCode,
  reason: string,
  maKhachHang: string,
  extra?: { httpStatus?: number; bodyPreview?: string },
): HanoiOnlinePaymentLinkResult {
  return { ok: false, code, reason, maKhachHang, ...extra };
}

/**
 * Lấy link thanh toán EVN Hà Nội.
 *
 * - **API**: truyền `accessToken` (Bearer từ `connect/token`) — không cần Playwright.
 * - **Browser**: truyền `page` — fallback khi `HANOI_USE_API_LOGIN=false`.
 *
 * PLACEHOLDER nghiệp vụ: endpoint cụ thể sẽ bổ sung sau.
 */
export async function fetchHanoiOnlinePaymentLink(
  maKhachHang: string,
  step: number,
  opts: { accessToken?: string; page?: Page },
): Promise<HanoiOnlinePaymentLinkResult> {
  const ma = maKhachHang.trim().toUpperCase();
  if (!ma) {
    return fail("EMPTY_RESPONSE", "Thiếu mã khách hàng", "");
  }

  if (!opts.accessToken && !opts.page) {
    return fail("NO_AUTH_CONTEXT", "Cần accessToken (API) hoặc page (Playwright).", ma);
  }

  const mode = opts.accessToken ? "api" : "browser";
  logger.warn(
    `[hanoi-online-payment] fetchHanoiOnlinePaymentLink chưa triển khai endpoint — mode=${mode} ma=${ma}`,
  );

  return fail(
    "NOT_IMPLEMENTED",
    "Chưa triển khai endpoint lấy link thanh toán EVN Hà Nội — vui lòng cung cấp thông tin API sau đăng nhập.",
    ma,
  );
}
