import { env } from "../../config/env.js";

const PDF_MAGIC = Buffer.from("%PDF-");
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const REFERER_PATH = "/dashboard/home/quan-ly-hoa-don/tra-cuu-hoa-don";

export interface HanoiXemHoaDonPdfQuery {
  maDvql: string;
  maKh: string;
  idHoaDon: number;
  loaiHoaDon: string;
}

export interface HanoiXemHoaDonPdfResponse {
  isError?: boolean;
  message?: string | null;
  data?: string | null;
  code?: number;
}

function buildUrl(q: HanoiXemHoaDonPdfQuery): string {
  const base = env.evnHanoiBaseUrl.replace(/\/$/, "");
  const u = new URL(`${base}/api/Cmis/XemHoaDonByMaKhachHang`);
  u.searchParams.set("maDvql", q.maDvql.trim());
  u.searchParams.set("maKh", q.maKh.trim());
  u.searchParams.set("idHoaDon", String(q.idHoaDon));
  u.searchParams.set("loaiHoaDon", q.loaiHoaDon.trim());
  return u.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET XemHoaDonByMaKhachHang — `data` là PDF base64.
 */
export async function fetchHanoiXemHoaDonPdf(
  accessToken: string,
  query: HanoiXemHoaDonPdfQuery,
): Promise<Buffer> {
  const url = buildUrl(query);
  const base = env.evnHanoiBaseUrl.replace(/\/$/, "");
  const referer = `${base}${REFERER_PATH}`;
  const maxRetries = env.hanoiTraCuuMaxRetries;
  const delayMs = env.hanoiTraCuuRetryDelayMs;
  const timeoutMs = Math.max(10_000, env.hanoiPdfXemHoaDonTimeoutMs);

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
        const err = new Error(`HANOI XemHoaDon HTTP ${res.status} — ${text.slice(0, 400)}`);
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          lastErr = err;
          await sleep(delayMs + Math.floor(Math.random() * 400));
          continue;
        }
        throw err;
      }

      let parsed: HanoiXemHoaDonPdfResponse;
      try {
        parsed = JSON.parse(text) as HanoiXemHoaDonPdfResponse;
      } catch {
        throw new Error("HANOI XemHoaDon: phản hồi không phải JSON");
      }

      if (parsed.isError === true) {
        throw new Error(`HANOI XemHoaDon: ${parsed.message ?? "isError"}`);
      }

      const b64 = parsed.data;
      if (typeof b64 !== "string" || b64.length < 20) {
        throw new Error("HANOI XemHoaDon: thiếu hoặc data base64 không hợp lệ");
      }

      let buf: Buffer;
      try {
        buf = Buffer.from(b64, "base64");
      } catch {
        throw new Error("HANOI XemHoaDon: không giải mã base64");
      }

      if (buf.length < 5 || !buf.subarray(0, 5).equals(PDF_MAGIC)) {
        throw new Error("HANOI XemHoaDon: dữ liệu không phải PDF (thiếu %PDF-)");
      }

      return buf;
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

  throw lastErr ?? new Error("HANOI XemHoaDon: retry exhausted");
}
