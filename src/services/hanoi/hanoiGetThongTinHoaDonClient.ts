import { env } from "../../config/env.js";
import type { HanoiDmThongTinHoaDonItem, HanoiGetThongTinHoaDonResponse } from "../../types/hanoiGetThongTinHoaDon.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const TRACUU_REFERER_PATH = "/dashboard/home/quan-ly-hoa-don/tra-cuu-hoa-don";

export interface HanoiGetThongTinHoaDonQuery {
  maDvql: string;
  /** Query `maKh` — mã khách hàng */
  maKh: string;
  thang: number;
  nam: number;
  ky: number;
}

function buildTraCuuUrl(q: HanoiGetThongTinHoaDonQuery): string {
  const base = env.evnHanoiBaseUrl.replace(/\/$/, "");
  const u = new URL(`${base}/api/TraCuu/GetThongTinHoaDon`);
  u.searchParams.set("maDvql", q.maDvql.trim());
  u.searchParams.set("maKh", q.maKh.trim());
  u.searchParams.set("thang", String(q.thang));
  u.searchParams.set("nam", String(q.nam));
  u.searchParams.set("ky", String(q.ky));
  return u.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldRetryHttp(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Lọc đúng kỳ/tháng/năm yêu cầu (API có thể trả nhiều kỳ trong cùng tháng).
 */
export function filterHanoiThongTinRowsForPeriod(
  rows: HanoiDmThongTinHoaDonItem[],
  requested: { ky: number; thang: number; nam: number },
): HanoiDmThongTinHoaDonItem[] {
  return rows.filter(
    (r) => r.ky === requested.ky && r.thang === requested.thang && r.nam === requested.nam,
  );
}

/** Các giá trị ky khác nhau xuất hiện trong danh sách (cùng tháng/năm). */
export function distinctKyInRows(rows: HanoiDmThongTinHoaDonItem[]): number[] {
  const s = new Set<number>();
  for (const r of rows) {
    if (Number.isFinite(r.ky)) s.add(r.ky);
  }
  return [...s].sort((a, b) => a - b);
}

/**
 * GET GetThongTinHoaDon — dùng cho bước sau (tải PDF theo idHdon).
 */
export async function fetchHanoiGetThongTinHoaDon(
  accessToken: string,
  query: HanoiGetThongTinHoaDonQuery,
): Promise<HanoiGetThongTinHoaDonResponse> {
  const url = buildTraCuuUrl(query);
  const base = env.evnHanoiBaseUrl.replace(/\/$/, "");
  const referer = `${base}${TRACUU_REFERER_PATH}`;

  const maxRetries = env.hanoiTraCuuMaxRetries;
  const delayMs = env.hanoiTraCuuRetryDelayMs;
  const timeoutMs = Math.max(5_000, env.hanoiTraCuuGetThongTinTimeoutMs);

  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          Referer: referer,
          "User-Agent": DEFAULT_UA,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await res.text().catch(() => "");

      if (!res.ok) {
        const err = new Error(`HANOI GetThongTinHoaDon HTTP ${res.status} — ${text.slice(0, 400)}`);
        if (shouldRetryHttp(res.status) && attempt < maxRetries) {
          lastErr = err;
          await sleep(delayMs + Math.floor(Math.random() * 400));
          continue;
        }
        throw err;
      }

      let parsed: HanoiGetThongTinHoaDonResponse;
      try {
        parsed = JSON.parse(text) as HanoiGetThongTinHoaDonResponse;
      } catch {
        throw new Error("HANOI GetThongTinHoaDon: phản hồi không phải JSON");
      }

      if (parsed.isError === true) {
        const msg = parsed.message ?? "isError=true";
        throw new Error(`HANOI GetThongTinHoaDon: ${msg}`);
      }

      return parsed;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const msg = err.message;
      const transient =
        /AbortError|timeout|HTTP\s(429|502|503|504)|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
      if (transient && attempt < maxRetries) {
        lastErr = err;
        await sleep(delayMs + Math.floor(Math.random() * 400));
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error("HANOI GetThongTinHoaDon: retry exhausted");
}
