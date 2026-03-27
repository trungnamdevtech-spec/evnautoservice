import type { Page } from "playwright";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { looksLikePdfBuffer, tryExtractPdfBufferFromTextPayload } from "./npcExtractPdfFromXemChiTiet.js";

export interface NpcXemChiTietHoaDonParams {
  /** Giá trị `id_hdon` từ billData (có thể chứa `=`, sẽ được encode form) */
  idHdon: string;
  maKh: string;
  ky: number | string;
  thang: number | string;
  nam: number | string;
}

export type NpcXemChiTietHoaDonResult =
  | {
      kind: "pdf";
      buffer: Buffer;
      url: string;
      status: number;
      statusText: string;
    }
  | {
      kind: "html";
      body: string;
      url: string;
      status: number;
      statusText: string;
    };

/**
 * POST `/HoaDon/XemChiTietHoaDon_NPC` — form x-www-form-urlencoded (giống curl DevTools).
 * Dùng cookie phiên hiện tại qua `page.context().request`.
 * Phân nhánh: PDF nhị phân / nhúng base64-JSON / HTML (để bóc tách sau).
 */
export async function postNpcXemChiTietHoaDon(
  page: Page,
  params: NpcXemChiTietHoaDonParams,
): Promise<NpcXemChiTietHoaDonResult> {
  const base = env.evnNpcBaseUrl.replace(/\/$/, "");
  const url = `${base}/HoaDon/XemChiTietHoaDon_NPC`;
  const referer = env.evnNpcIndexNpcUrl;
  const origin = base;

  const ky = String(typeof params.ky === "number" ? params.ky : Number.parseInt(String(params.ky), 10));
  const thang = String(
    typeof params.thang === "number" ? params.thang : Number.parseInt(String(params.thang), 10),
  );
  const nam = String(typeof params.nam === "number" ? params.nam : Number.parseInt(String(params.nam), 10));

  const res = await page.context().request.post(url, {
    headers: {
      Accept: "*/*",
      "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
      Origin: origin,
      Referer: referer,
      "X-Requested-With": "XMLHttpRequest",
    },
    form: {
      IDHoaDon: params.idHdon.trim(),
      ma_kh: params.maKh.trim(),
      ky,
      thang,
      nam,
    },
    timeout: 120_000,
  });

  const status = res.status();
  const statusText = res.statusText();
  const ct = (res.headers()["content-type"] || "").toLowerCase();

  if (ct.includes("application/pdf")) {
    const buffer = await res.body();
    logger.debug(`[npc-xem-ct] POST XemChiTiet → PDF trực tiếp HTTP ${status} bytes=${buffer.length}`);
    return { kind: "pdf", buffer, url, status, statusText };
  }

  if (ct.includes("application/octet-stream")) {
    const buffer = await res.body();
    if (looksLikePdfBuffer(buffer)) {
      logger.debug(`[npc-xem-ct] POST XemChiTiet → octet-stream PDF HTTP ${status} bytes=${buffer.length}`);
      return { kind: "pdf", buffer, url, status, statusText };
    }
    const asText = buffer.toString("utf8");
    const fromB64 = tryExtractPdfBufferFromTextPayload(asText);
    if (fromB64) {
      logger.debug(
        `[npc-xem-ct] POST XemChiTiet → octet-stream là chuỗi base64 PDF HTTP ${status} bytes=${fromB64.length}`,
      );
      return { kind: "pdf", buffer: fromB64, url, status, statusText };
    }
    logger.debug(`[npc-xem-ct] POST XemChiTiet → octet-stream không phải PDF HTTP ${status}`);
    return { kind: "html", body: asText, url, status, statusText };
  }

  const text = await res.text().catch(() => "");
  const embedded = tryExtractPdfBufferFromTextPayload(text);
  if (embedded) {
    logger.debug(`[npc-xem-ct] POST XemChiTiet → PDF nhúng trong text HTTP ${status} bytes=${embedded.length}`);
    return { kind: "pdf", buffer: embedded, url, status, statusText };
  }

  logger.debug(`[npc-xem-ct] POST XemChiTietHoaDon_NPC HTTP ${status} ${statusText} textLen=${text.length}`);
  return { kind: "html", body: text, url, status, statusText };
}
