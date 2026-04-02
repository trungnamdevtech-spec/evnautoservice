import { env } from "../../config/env.js";
import type { HanoiDmThongTinHoaDonItem, HanoiGetThongTinHoaDonResponse } from "../../types/hanoiGetThongTinHoaDon.js";
import { buildHanoiApiAuthHeaders } from "./hanoiApiHeaders.js";

/**
 * GET Tra cứu thông tin hóa đơn theo `(maDvql, maKh, tháng, năm, ky)`.
 *
 * **Nghiệp vụ:** Response `data.dmThongTinHoaDonList` cho biết trong tháng đó có **các kỳ** nào (thường 1–3 dòng,
 * mỗi dòng một `ky` và một `idHdon`). Cùng một `idHdon`, pipeline tải PDF **TD** (thông báo tiền điện) và **GTGT**
 * (nếu bật `HANOI_DOWNLOAD_PAYMENT_PDF`) qua `XemHoaDonByMaKhachHang`.
 *
 * Query `ky` trên URL là tham số bắt buộc của API; worker có thể gọi **lần lượt** `ky=1,2,3` rồi gộp + khử trùng
 * `idHdon`, rồi lọc `filterHanoiThongTinRowsForMonth` để xử lý **mọi kỳ** trong tháng (phục vụ truy vấn).
 *
 * Hợp đồng HTTP:
 * ```
 * GET {EVN_HANOI_BASE_URL}/api/TraCuu/GetThongTinHoaDon
 *   ?maDvql=<MA_DVIQLY>&maKh=<MA_KHACH_HANG>&thang=<1-12>&nam=<YYYY>&ky=<1|2|3>
 * Headers: Authorization: Bearer <access_token>
 *         Referer: {EVN_HANOI_BASE_URL}/dashboard/home/quan-ly-hoa-don/tra-cuu-hoa-don
 *         Accept: application/json
 *         + sec-ch-ua*, User-Agent (xem `hanoiApiHeaders.ts`)
 * ```
 */
export const HANOI_GET_THONG_TIN_HOA_DON_REFERER_PATH = "/dashboard/home/quan-ly-hoa-don/tra-cuu-hoa-don";

export interface HanoiGetThongTinHoaDonQuery {
  maDvql: string;
  /** Query `maKh` — mã khách hàng */
  maKh: string;
  thang: number;
  nam: number;
  /** Tham số URL (1–3). Một số bản triển khai API trả nhiều kỳ trong list dù chỉ gọi một `ky`. */
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
 * Giữ các dòng khớp **đúng** `(ky, thang, nam)` — dùng sau khi gộp response hoặc khi API trả nhiều kỳ trong tháng.
 */
export function filterHanoiThongTinRowsForPeriod(
  rows: HanoiDmThongTinHoaDonItem[],
  requested: { ky: number; thang: number; nam: number },
): HanoiDmThongTinHoaDonItem[] {
  return rows.filter(
    (r) => r.ky === requested.ky && r.thang === requested.thang && r.nam === requested.nam,
  );
}

/**
 * Giữ mọi dòng khớp `(thang, nam)` và `ky` ∈ {1,2,3} — dùng khi quét **cả tháng** (mọi kỳ), không lọc một `ky` task.
 */
export function filterHanoiThongTinRowsForMonth(
  rows: HanoiDmThongTinHoaDonItem[],
  requested: { thang: number; nam: number },
): HanoiDmThongTinHoaDonItem[] {
  return rows.filter(
    (r) =>
      r.thang === requested.thang &&
      r.nam === requested.nam &&
      Number.isFinite(r.ky) &&
      r.ky >= 1 &&
      r.ky <= 3,
  );
}

/**
 * Khử trùng theo `idHdon` (giữ dòng đầu) — sau khi gộp nhiều lần GET theo `ky` URL.
 */
export function dedupeHanoiDmThongTinByIdHdon(rows: HanoiDmThongTinHoaDonItem[]): HanoiDmThongTinHoaDonItem[] {
  const seen = new Set<number>();
  const out: HanoiDmThongTinHoaDonItem[] = [];
  for (const r of rows) {
    if (seen.has(r.idHdon)) continue;
    seen.add(r.idHdon);
    out.push(r);
  }
  return out;
}

/**
 * Các giá trị `ky` khác nhau trong list (cùng tháng/năm) — **đếm `.length`** để biết tháng đó API trả bao nhiêu kỳ
 * (tối đa 3). Khác với `filterHanoiThongTinRowsForPeriod` (chọn đúng một kỳ task).
 */
export function distinctKyInRows(rows: HanoiDmThongTinHoaDonItem[]): number[] {
  const s = new Set<number>();
  for (const r of rows) {
    if (Number.isFinite(r.ky)) s.add(r.ky);
  }
  return [...s].sort((a, b) => a - b);
}

/** Kiểm tra envelope JSON sau GET GetThongTinHoaDon (`data.dmThongTinHoaDonList`). */
export interface HanoiGetThongTinHoaDonValidationResult {
  ok: boolean;
  reasons: string[];
  listLength: number;
}

export function validateHanoiGetThongTinHoaDonResponse(
  parsed: HanoiGetThongTinHoaDonResponse,
): HanoiGetThongTinHoaDonValidationResult {
  const reasons: string[] = [];
  if (parsed.isError === true) {
    reasons.push(`isError: ${String(parsed.message ?? "")}`);
  }
  const data = parsed.data;
  let listLength = 0;
  if (data != null && typeof data === "object") {
    const list = data.dmThongTinHoaDonList;
    if (list !== undefined && !Array.isArray(list)) {
      reasons.push("data.dmThongTinHoaDonList không phải mảng");
    } else if (Array.isArray(list)) {
      listLength = list.length;
    }
  }
  return { ok: reasons.length === 0, reasons, listLength };
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
  const referer = `${base}${HANOI_GET_THONG_TIN_HOA_DON_REFERER_PATH}`;

  const maxRetries = env.hanoiTraCuuMaxRetries;
  const delayMs = env.hanoiTraCuuRetryDelayMs;
  const timeoutMs = Math.max(5_000, env.hanoiTraCuuGetThongTinTimeoutMs);

  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: buildHanoiApiAuthHeaders(accessToken, referer),
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

/**
 * Giống `fetchHanoiGetThongTinHoaDon` nhưng **không** throw khi `isError: true` (chỉ throw HTTP lỗi / JSON hỏng).
 * Dùng khi cần đọc `message` nghiệp vụ hoặc script chẩn đoán.
 */
export async function fetchHanoiGetThongTinHoaDonIncludingBusinessError(
  accessToken: string,
  query: HanoiGetThongTinHoaDonQuery,
): Promise<HanoiGetThongTinHoaDonResponse> {
  const url = buildTraCuuUrl(query);
  const base = env.evnHanoiBaseUrl.replace(/\/$/, "");
  const referer = `${base}${HANOI_GET_THONG_TIN_HOA_DON_REFERER_PATH}`;
  const timeoutMs = Math.max(5_000, env.hanoiTraCuuGetThongTinTimeoutMs);

  const res = await fetch(url, {
    method: "GET",
    headers: buildHanoiApiAuthHeaders(accessToken, referer),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`HANOI GetThongTinHoaDon HTTP ${res.status} — ${text.slice(0, 400)}`);
  }

  let parsed: HanoiGetThongTinHoaDonResponse;
  try {
    parsed = JSON.parse(text) as HanoiGetThongTinHoaDonResponse;
  } catch {
    throw new Error("HANOI GetThongTinHoaDon: phản hồi không phải JSON");
  }

  return parsed;
}
