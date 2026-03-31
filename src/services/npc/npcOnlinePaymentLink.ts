import type { Page } from "playwright";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { buildNpcXhrHeaders, npcHumanPause } from "./npcBrowserLikeHeaders.js";
import { dismissNpcOverlayModalIfPresent } from "../../providers/npc/npcLogin.js";

/** Kết quả lấy link cổng thanh toán apicskhthanhtoan (sau POST Tra cứu). */
export type NpcOnlinePaymentLinkResult =
  | {
      ok: true;
      paymentUrl: string;
      maKhachHang: string;
      httpStatus: number;
    }
  | {
      ok: false;
      reason: string;
      code: NpcOnlinePaymentLinkErrorCode;
      maKhachHang: string;
      httpStatus?: number;
      bodyPreview?: string;
    };

export type NpcOnlinePaymentLinkErrorCode =
  | "HTTP_ERROR"
  | "NO_PAYMENT_LINK_IN_HTML"
  | "EMPTY_RESPONSE";

/**
 * Trích URL `https://apicskhthanhtoan.npc.com.vn/Home/ThanhToan?param=...` từ HTML fragment server trả về.
 */
export function parsePaymentLinkFromNpcThanhToanHtml(html: string): string | null {
  const decoded = html.replace(/&amp;/g, "&");
  const re =
    /https?:\/\/apicskhthanhtoan\.npc\.com\.vn\/Home\/ThanhToan\?param=[^"'&\s<>]+/i;
  const m = decoded.match(re);
  return m ? m[0] : null;
}

function fail(
  code: NpcOnlinePaymentLinkErrorCode,
  reason: string,
  maKhachHang: string,
  extra?: { httpStatus?: number; bodyPreview?: string },
): NpcOnlinePaymentLinkResult {
  return { ok: false, code, reason, maKhachHang, ...extra };
}

/**
 * Điều hướng trang thanh toán trực tuyến → POST Tra cứu (cùng payload như nút "Tra cứu" trên trang)
 * → trích link THANH TOÁN. Cần phiên đã đăng nhập CSKH NPC.
 *
 * @see https://cskh.npc.com.vn/DichVuTrucTuyen/ThanhToanTrucTuyenNPC_TTTD
 */
export async function fetchNpcOnlinePaymentLink(
  page: Page,
  maKhachHang: string,
  step: number,
): Promise<NpcOnlinePaymentLinkResult> {
  const ma = maKhachHang.trim().toUpperCase();
  if (!ma) {
    return fail("EMPTY_RESPONSE", "Thiếu mã khách hàng", "");
  }

  const base = env.evnNpcBaseUrl.replace(/\/$/, "");
  const pagePath = env.evnNpcThanhToanTrucTuyenPath.replace(/^\//, "");
  const pageUrl = `${base}/${pagePath}`;
  const postUrl = `${base}/ThanhToanTrucTuyen/XuLyThanhToanTrucTuyenSPC`;

  await npcHumanPause();
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: step });
  await dismissNpcOverlayModalIfPresent(page, step);

  await npcHumanPause();

  const tryFill = async (): Promise<void> => {
    const selectors = [
      'input[name="MaKhachHang"]',
      'input[id*="MaKhach" i]',
      'input[placeholder*="Mã khách hàng" i]',
    ];
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.fill(ma);
        await new Promise<void>((r) => setTimeout(r, 200));
        return;
      }
    }
  };
  await tryFill();

  const xhr = await buildNpcXhrHeaders(page, pageUrl);
  const res = await page.request.post(postUrl, {
    headers: {
      ...xhr,
      Accept: "text/html, */*; q=0.01",
      Origin: base,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    form: { MaKhachHang: ma },
    timeout: 120_000,
  });

  const httpStatus = res.status();
  const body = await res.text().catch(() => "");

  if (httpStatus >= 400) {
    logger.warn(`[npc-online-payment] POST XuLyThanhToanTrucTuyenSPC HTTP ${httpStatus} len=${body.length}`);
    return fail(
      "HTTP_ERROR",
      `Trả về HTTP ${httpStatus} — có thể phiên hết hạn hoặc WAF chặn.`,
      ma,
      { httpStatus, bodyPreview: body.slice(0, 2048) },
    );
  }

  if (!body || body.trim().length < 10) {
    return fail("EMPTY_RESPONSE", "Phản hồi rỗng.", ma, { httpStatus });
  }

  const paymentUrl = parsePaymentLinkFromNpcThanhToanHtml(body);
  if (!paymentUrl) {
    logger.warn(`[npc-online-payment] Không có link apicskhthanhtoan trong HTML (len=${body.length})`);
    return fail(
      "NO_PAYMENT_LINK_IN_HTML",
      "Không tìm thấy link thanh toán (apicskhthanhtoan) trong phản hồi — có thể không có nợ / chưa phát sinh thanh toán.",
      ma,
      { httpStatus, bodyPreview: body.slice(0, 2048) },
    );
  }

  logger.info(`[npc-online-payment] OK ma=${ma} link len=${paymentUrl.length}`);
  return { ok: true, paymentUrl, maKhachHang: ma, httpStatus };
}
