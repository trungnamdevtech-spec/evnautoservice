import type { Page } from "playwright";
import { env } from "../../config/env.js";

function npcHostname(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isNpcSameSite(pageUrl: string): boolean {
  const base = env.evnNpcBaseUrl.replace(/\/$/, "");
  const h = npcHostname(pageUrl);
  const hBase = npcHostname(base);
  return h.length > 0 && h === hBase;
}

/**
 * Header giống XHR/fetch same-origin trên Chromium — WAF thường so khớp Referer, User-Agent, Sec-Fetch-*.
 * Referer ưu tiên URL tab hiện tại (đúng với phiên) thay vì chỉ URL tĩnh từ env.
 */
export async function buildNpcXhrHeaders(page: Page, refererFallback: string): Promise<Record<string, string>> {
  const ua = await page.evaluate(() => navigator.userAgent);
  const cur = page.url();
  const referer = isNpcSameSite(cur) ? cur : refererFallback;

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

/** Chờ ngẫu nhiên giữa các thao tác API — giảm pattern thời gian cố định (bot). */
export async function npcHumanPause(): Promise<void> {
  const a = env.npcHumanJitterMinMs;
  const b = env.npcHumanJitterMaxMs;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}
