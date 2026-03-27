import type { Page } from "playwright";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";

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
export async function fetchNpcTraCuuHdsPc(
  page: Page,
  params: NpcTraCuuHdsPcParams,
): Promise<NpcTraCuuHdsPcResult> {
  const url = buildNpcTraCuuHdsPcUrl(params);
  const referer = env.evnNpcIndexNpcUrl;

  const res = await page.context().request.get(url, {
    headers: {
      Accept: "text/html, */*; q=0.01",
      "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
      "Content-Type": "application/json; charset=utf-8",
      Referer: referer,
      "X-Requested-With": "XMLHttpRequest",
    },
    timeout: 60_000,
  });

  const body = await res.text().catch(() => "");
  logger.debug(
    `[npc-tra-cuu] GET TraCuuHDSPC HTTP ${res.status()} ${res.statusText()} bytes=${body.length}`,
  );

  return {
    url,
    status: res.status(),
    statusText: res.statusText(),
    body,
  };
}
