import type { Page } from "playwright";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { buildNpcXhrHeaders } from "./npcBrowserLikeHeaders.js";

/**
 * Tra cứu hóa đơn SPC trên CSKH NPC (sau khi đã có session + cookie trên `page`).
 * GET `/HoaDon/TraCuuHDSPC?ky=&thang=&nam=&_=timestamp` — cùng pattern DevTools/curl.
 */
export interface NpcTraCuuHdsPcParams {
  /** Kỳ trong tháng (1–3 … tùy site) */
  ky: number | string;
  thang: number | string;
  nam: number | string;
}

export interface NpcTraCuuHdsPcResult {
  url: string;
  status: number;
  statusText: string;
  body: string;
}

function normalizeQueryInt(v: number | string): string {
  const n = typeof v === "number" ? v : Number.parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(`NpcTraCuuHdsPc: tham số không phải số hợp lệ: ${String(v)}`);
  }
  return String(n);
}

export function buildNpcTraCuuHdsPcUrl(params: NpcTraCuuHdsPcParams): string {
  const base = env.evnNpcBaseUrl.replace(/\/$/, "");
  const qs = new URLSearchParams();
  qs.set("ky", normalizeQueryInt(params.ky));
  qs.set("thang", normalizeQueryInt(params.thang));
  qs.set("nam", normalizeQueryInt(params.nam));
  qs.set("_", String(Date.now()));
  return `${base}/HoaDon/TraCuuHDSPC?${qs.toString()}`;
}

/**
 * Gọi API bằng request context của Playwright — tự gửi cookie phiên (SessionId, antiforgery, …).
 */
function shouldRetryTraCuuStatus(status: number): boolean {
  return status === 403 || status === 429 || status === 502 || status === 503;
}

/**
 * GET giống trình duyệt (không gửi Content-Type: application/json — một số WAF chặn GET lạ).
 * Dùng `page.request` + header từ tab (Referer/UA/Sec-Fetch) để khớp phiên Chromium.
 */
export async function fetchNpcTraCuuHdsPc(
  page: Page,
  params: NpcTraCuuHdsPcParams,
): Promise<NpcTraCuuHdsPcResult> {
  const url = buildNpcTraCuuHdsPcUrl(params);
  const refererFallback = env.evnNpcIndexNpcUrl;
  const maxAttempts = 1 + env.npcTraCuuMaxRetries;

  let lastStatus = 0;
  let lastText = "";
  let lastStatusText = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers = await buildNpcXhrHeaders(page, refererFallback);
    const res = await page.request.get(url, {
      headers,
      timeout: 60_000,
    });

    lastStatus = res.status();
    lastStatusText = res.statusText();
    lastText = await res.text().catch(() => "");

    logger.debug(
      `[npc-tra-cuu] GET TraCuuHDSPC attempt ${attempt}/${maxAttempts} HTTP ${lastStatus} ${lastStatusText} bytes=${lastText.length}`,
    );

    if (!shouldRetryTraCuuStatus(lastStatus) || attempt === maxAttempts) {
      return {
        url,
        status: lastStatus,
        statusText: lastStatusText,
        body: lastText,
      };
    }

    logger.warn(
      `[npc-tra-cuu] TraCuuHDSPC HTTP ${lastStatus} — chờ ${env.npcTraCuuRetryDelayMs}ms rồi thử lại (${attempt}/${maxAttempts})`,
    );
    await new Promise((r) => setTimeout(r, env.npcTraCuuRetryDelayMs));
  }

  return {
    url,
    status: lastStatus,
    statusText: lastStatusText,
    body: lastText,
  };
}
