import type { Page } from "playwright";
import type { env as EnvType } from "../../config/env.js";

type Env = typeof EnvType;

function hanoiHostname(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isHanoiSameSite(pageUrl: string, baseUrl: string): boolean {
  const h = hanoiHostname(pageUrl);
  const hBase = hanoiHostname(baseUrl);
  return h.length > 0 && h === hBase;
}

/**
 * Header giống XHR/fetch same-origin Chromium cho EVN Hà Nội.
 * Referer ưu tiên URL tab hiện tại (khớp phiên) thay vì URL tĩnh.
 */
export async function buildHanoiXhrHeaders(
  page: Page,
  refererFallback: string,
  baseUrl: string,
): Promise<Record<string, string>> {
  const ua = await page.evaluate(() => navigator.userAgent);
  const cur = page.url();
  const referer = isHanoiSameSite(cur, baseUrl) ? cur : refererFallback;

  return {
    Accept: "*/*",
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: referer,
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    ...(ua ? { "User-Agent": ua } : {}),
  };
}

/** Chờ ngẫu nhiên giữa các thao tác API — giảm pattern bot. */
export async function hanoiHumanPause(env: Env): Promise<void> {
  const a = env.hanoiHumanJitterMinMs;
  const b = env.hanoiHumanJitterMaxMs;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}
