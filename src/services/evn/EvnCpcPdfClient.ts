import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import type { CpcPdfApiResponse, PdfFileType } from "../../types/invoiceItem.js";

export type { PdfFileType };

export interface PdfDownloadParams {
  orgCode: string;
  billId: string | number;
  fileType: PdfFileType;
  customerCode: string;
}

export interface PdfDownloadResult {
  filePath: string;
  bytes: number;
}

const PDF_API_URL = `${env.evnCpcApiBaseUrl}/remote/invoice/file/pdf`;

/** Magic bytes của PDF — dùng để xác thực dữ liệu trước khi lưu */
const PDF_MAGIC = Buffer.from("%PDF-");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Rate limiter kiểu fixed-window đơn giản (process-local).
 * Mục tiêu: giữ tốc độ gọi API PDF thấp hơn quota CPC để tránh 429 hàng loạt.
 */
class FixedWindowRateLimiter {
  private windowStartedAt = 0;
  private used = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs = 60_000,
  ) {}

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      if (this.windowStartedAt === 0 || now - this.windowStartedAt >= this.windowMs) {
        this.windowStartedAt = now;
        this.used = 0;
      }
      if (this.used < this.maxPerWindow) {
        this.used++;
        return;
      }
      const waitMs = Math.max(100, this.windowMs - (now - this.windowStartedAt) + 50);
      logger.warn(`[pdf] Chạm ngưỡng ${this.maxPerWindow}/${Math.round(this.windowMs / 1000)}s, chờ ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

/**
 * Gọi API CPC để tải file PDF (thông báo TBAO hoặc hóa đơn HDON).
 * Response trả về JSON có field `pdf` chứa chuỗi base64.
 * API yêu cầu Bearer token lấy từ phiên đăng nhập hiện tại.
 */
export class EvnCpcPdfClient {
  private static readonly limiter = new FixedWindowRateLimiter(
    Math.max(1, Math.min(100, env.evnCpcPdfMaxPerMinute)),
  );

  constructor(private readonly bearerToken: string) {}

  /**
   * Tải một file PDF, giải mã base64, xác thực magic bytes rồi lưu ra disk.
   * Trả về đường dẫn file và kích thước byte.
   */
  async downloadAndSave(params: PdfDownloadParams): Promise<PdfDownloadResult> {
    const maxRetries = Math.max(0, env.evnCpcPdf429MaxRetries);
    const baseDelay = Math.max(200, env.evnCpcPdf429BaseDelayMs);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await EvnCpcPdfClient.limiter.acquire();
        return await this.downloadOnce(params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isRateLimit = /HTTP\s*429\b|quota exceeded|too many requests/i.test(message);
        if (!isRateLimit || attempt >= maxRetries) {
          throw err;
        }
        const jitter = Math.floor(Math.random() * 500);
        const delayMs = Math.min(60_000, baseDelay * 2 ** attempt + jitter);
        logger.warn(
          `[pdf] 429 rate limit billId=${params.billId} attempt=${attempt + 1}/${maxRetries + 1}, retry sau ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
    throw new Error("PDF download retry loop exited unexpectedly");
  }

  private async downloadOnce(params: PdfDownloadParams): Promise<PdfDownloadResult> {
    const { orgCode, billId, fileType, customerCode } = params;

    logger.debug(
      `[pdf] POST ${PDF_API_URL} — billId=${billId} fileType=${fileType} orgCode=${orgCode} customerCode=${customerCode}`,
    );

    const res = await fetch(PDF_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json",
        "Accept-Language": "vi",
        Authorization: `Bearer ${this.bearerToken}`,
        Origin: "https://cskh.cpc.vn",
        Referer: "https://cskh.cpc.vn/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        orgCode,
        billId: String(billId),
        fileType,
        customerCode,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`PDF API HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as CpcPdfApiResponse;

    const base64 = json?.pdf;
    if (!base64 || base64.trim().length === 0) {
      const preview = JSON.stringify(json).slice(0, 300);
      throw new Error(`Field 'pdf' rỗng hoặc không tồn tại trong response: ${preview}`);
    }

    // Giải mã base64 → buffer nhị phân
    const pdfBuffer = Buffer.from(base64, "base64");

    // Xác thực: PDF hợp lệ phải bắt đầu bằng "%PDF-"
    if (!pdfBuffer.slice(0, 5).equals(PDF_MAGIC)) {
      throw new Error(
        `Dữ liệu không phải PDF hợp lệ (magic bytes sai). ` +
          `Đầu buffer: ${pdfBuffer.slice(0, 16).toString("hex")}`,
      );
    }

    const filePath = buildFilePath(orgCode, billId, fileType, customerCode);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, pdfBuffer);

    logger.debug(`[pdf] ✓ Đã lưu ${pdfBuffer.length.toLocaleString()} bytes → ${filePath}`);
    return { filePath, bytes: pdfBuffer.length };
  }
}

/**
 * Tạo đường dẫn file chuẩn hóa:
 * {PDF_OUTPUT_DIR}/{orgCode4}/{orgCode}_{customerCode}_{billId}_{fileType}.pdf
 *
 * Ví dụ: ./output/pdfs/pc01/pc01aa_pc01aa0433252_1591530428_tbao.pdf
 */
function buildFilePath(
  orgCode: string,
  billId: string | number,
  fileType: string,
  customerCode: string,
): string {
  const name = `${orgCode}_${customerCode}_${billId}_${fileType}.pdf`
    .replace(/[^\w\-_.]/g, "_")
    .toLowerCase();
  const subDir = orgCode.slice(0, 4).toLowerCase();
  return path.join(env.pdfOutputDir, subDir, name);
}
