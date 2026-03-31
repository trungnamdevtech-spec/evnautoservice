import type { Page } from "playwright";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { buildNpcXhrHeaders } from "./npcBrowserLikeHeaders.js";
import { looksLikePdfBuffer, tryExtractPdfBufferFromTextPayload } from "./npcExtractPdfFromXemChiTiet.js";

export interface NpcHoaDonFormParams {
  idHdon: string;
  maKh: string;
  ky: number | string;
  thang: number | string;
  nam: number | string;
}

export type NpcHoaDonFormResult =
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

export type NpcHoaDonNpcEndpoint = "XemChiTietHoaDon_NPC" | "XemHoaDon_NPC";

/**
 * POST `/HoaDon/XemChiTietHoaDon_NPC` (thông báo) hoặc `/HoaDon/XemHoaDon_NPC` (hóa đơn thanh toán).
 * Form x-www-form-urlencoded — cookie phiên qua `page.request`.
 */
export async function postNpcHoaDonNpcForm(
  page: Page,
  endpoint: NpcHoaDonNpcEndpoint,
  params: NpcHoaDonFormParams,
): Promise<NpcHoaDonFormResult> {
  const base = env.evnNpcBaseUrl.replace(/\/$/, "");
  const url = `${base}/HoaDon/${endpoint}`;
  const refererFallback = env.evnNpcIndexNpcUrl;
  const origin = base;

  const ky = String(typeof params.ky === "number" ? params.ky : Number.parseInt(String(params.ky), 10));
  const thang = String(
    typeof params.thang === "number" ? params.thang : Number.parseInt(String(params.thang), 10),
  );
  const nam = String(typeof params.nam === "number" ? params.nam : Number.parseInt(String(params.nam), 10));

  const xhr = await buildNpcXhrHeaders(page, refererFallback);
  const res = await page.request.post(url, {
    headers: {
      ...xhr,
      Origin: origin,
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
    logger.debug(`[npc-hoadon-form] POST ${endpoint} → PDF trực tiếp HTTP ${status} bytes=${buffer.length}`);
    return { kind: "pdf", buffer, url, status, statusText };
  }

  if (ct.includes("application/octet-stream")) {
    const buffer = await res.body();
    if (looksLikePdfBuffer(buffer)) {
      logger.debug(`[npc-hoadon-form] POST ${endpoint} → octet-stream PDF HTTP ${status} bytes=${buffer.length}`);
      return { kind: "pdf", buffer, url, status, statusText };
    }
    const asText = buffer.toString("utf8");
    const fromB64 = tryExtractPdfBufferFromTextPayload(asText);
    if (fromB64) {
      logger.debug(
        `[npc-hoadon-form] POST ${endpoint} → octet-stream base64 PDF HTTP ${status} bytes=${fromB64.length}`,
      );
      return { kind: "pdf", buffer: fromB64, url, status, statusText };
    }
    logger.debug(`[npc-hoadon-form] POST ${endpoint} → octet-stream không phải PDF HTTP ${status}`);
    return { kind: "html", body: asText, url, status, statusText };
  }

  const text = await res.text().catch(() => "");
  const embedded = tryExtractPdfBufferFromTextPayload(text);
  if (embedded) {
    logger.debug(`[npc-hoadon-form] POST ${endpoint} → PDF nhúng text HTTP ${status} bytes=${embedded.length}`);
    return { kind: "pdf", buffer: embedded, url, status, statusText };
  }

  logger.debug(`[npc-hoadon-form] POST ${endpoint} HTTP ${status} ${statusText} textLen=${text.length}`);
  return { kind: "html", body: text, url, status, statusText };
}
