import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";

export interface ImageCaptchaSolveRequest {
  /** Base64 thuần (không gồm tiền tố data:image/...) */
  imageBase64: string;
  mimeType?: string;
}

function normalizeImgPayload(raw: string): string {
  const t = raw.trim();
  const m = /^data:image\/[^;]+;base64,(.+)$/i.exec(t);
  return (m ? m[1] : t).replace(/\s/g, "");
}

/** Phản hồi JSON từ https://anticaptcha.top/api/captcha */
interface AnticaptchaTopResponse {
  success?: boolean;
  message?: string;
  captcha?: string;
}

/**
 * anticaptcha.top — Image to Text Autodetect (type 14, casesensitive=1), POST /api/captcha
 */
export class AnticaptchaClient {
  constructor(
    private readonly apiKey = env.anticaptchaApiKey,
    private readonly baseUrl = env.anticaptchaApiUrl.replace(/\/$/, ""),
  ) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async solveImageCaptcha(req: ImageCaptchaSolveRequest): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("AnticaptchaClient: chưa cấu hình ANTICAPTCHA_API_KEY");
    }

    const img = normalizeImgPayload(req.imageBase64);
    if (!img) {
      throw new Error("AnticaptchaClient: ảnh captcha rỗng");
    }

    const url = `${this.baseUrl}/captcha`;
    logger.debug(
      `[anticaptcha] POST ${url} (type=${env.anticaptchaType}, casesensitive=${env.anticaptchaCasesensitive}, ~${Math.round(img.length / 1024)}KB)`,
    );

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apikey: this.apiKey,
        img,
        type: env.anticaptchaType,
        casesensitive: env.anticaptchaCasesensitive,
      }),
    });

    const text = await res.text().catch(() => "");
    let data: AnticaptchaTopResponse;
    try {
      data = JSON.parse(text) as AnticaptchaTopResponse;
    } catch {
      throw new Error(`AnticaptchaClient: phản hồi không phải JSON (HTTP ${res.status}) ${text.slice(0, 200)}`);
    }

    if (!res.ok || data.success === false) {
      throw new Error(
        `AnticaptchaClient: ${data.message ?? "thất bại"} (HTTP ${res.status})`,
      );
    }

    const solution = data.captcha?.trim();
    if (!solution) {
      throw new Error(`AnticaptchaClient: không có trường captcha: ${JSON.stringify(data)}`);
    }
    logger.debug(`[anticaptcha] Nhận mã từ API (${solution.length} ký tự)`);
    return solution;
  }
}
