import type { Browser, BrowserContext, BrowserContextOptions, Download, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { env } from "../config/env.js";
import type { AnticaptchaClient } from "../services/captcha/AnticaptchaClient.js";
import { logger } from "./logger.js";
import { runWithTimeout } from "./stepTimeout.js";

chromium.use(StealthPlugin());

export interface CaptchaFlowSelectors {
  captchaImage: string;
  captchaInput: string;
  changeCodeButton: string;
}

export interface HandleCaptchaWithRetryOptions {
  page: Page;
  selectors: CaptchaFlowSelectors;
  stepTimeoutMs: number;
  maxAttempts?: number;
  /**
   * Lấy base64 từ DOM (ví dụ `img[src^="data:image"]`) — phù hợp API anticaptcha .
   * Nếu không có, chụp ảnh element captcha.
   */
  getImageBase64?: () => Promise<string>;
  /**
   * Sau khi submit báo sai captcha (trước lần thử tiếp theo): ví dụ NPC reload về màn chọn loại tài khoản —
   * cần bấm lại "Mã Khách hàng sử dụng điện" và điền lại form.
   * Nếu không set, mặc định chỉ bấm nút "Làm mới" captcha (`changeCodeButton`).
   */
  preparePageForRetry?: () => Promise<void>;
  /**
   * Thực hiện submit tra cứu sau khi điền captcha.
   * Trả về shouldRetryCaptcha: true khi site báo sai mã (cần bấm "Thay đổi mã" và giải lại).
   */
  submit: () => Promise<{ shouldRetryCaptcha: boolean }>;
}

/**
 * Chuẩn hóa storageState từ MongoDB (JSON string | object).
 */
export function normalizeStorageState(
  raw: string | Record<string, unknown> | undefined,
): BrowserContextOptions["storageState"] {
  if (raw === undefined) return undefined;
  if (typeof raw === "object") return raw as BrowserContextOptions["storageState"];
  try {
    return JSON.parse(raw) as BrowserContextOptions["storageState"];
  } catch {
    return raw;
  }
}

export abstract class BaseWorker {
  protected browser: Browser | null = null;
  private disposingBrowserPromise: Promise<void> | null = null;
  private sessionLock: Promise<void> = Promise.resolve();

  /**
   * Số phiên tra cứu đang giữ Chromium mở (hỗ trợ workerConcurrency > 1 trên cùng một worker).
   * Khi về 0 → đóng browser để không treo process khi agent không gọi task.
   */
  private activeBrowserSessions = 0;

  constructor(protected readonly captchaClient: AnticaptchaClient) {}

  private async withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLock;
    let release: (() => void) | undefined;
    this.sessionLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  async initStealthBrowser(): Promise<Browser> {
    if (this.disposingBrowserPromise) {
      await this.disposingBrowserPromise;
    }
    if (this.browser) return this.browser;
    this.browser = await chromium.launch({
      headless: env.playwrightHeadless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    logger.info("[browser] Đã khởi động Chromium (theo yêu cầu tra cứu).");
    return this.browser;
  }

  /**
   * Bắt đầu một phiên dùng browser (mỗi task EVN CPC gọi một lần trước khi tạo context).
   * Các provider khác sau này có thể không dùng cơ chế này.
   */
  async beginBrowserSession(): Promise<void> {
    await this.withSessionLock(async () => {
      await this.initStealthBrowser();
      this.activeBrowserSessions++;
    });
  }

  /**
   * Kết thúc phiên: khi không còn phiên nào → đóng Chromium.
   */
  async endBrowserSession(): Promise<void> {
    await this.withSessionLock(async () => {
      this.activeBrowserSessions = Math.max(0, this.activeBrowserSessions - 1);
      if (this.activeBrowserSessions === 0) {
        await this.disposeBrowser();
        logger.info("[browser] Đã đóng Chromium — không còn task tra cứu đang chạy.");
      }
    });
  }

  /**
   * Mỗi task: `browser.newContext({ storageState })` — không dùng launchPersistentContext.
   */
  async createDisposableContext(
    storageState?: BrowserContextOptions["storageState"],
  ): Promise<BrowserContext> {
    const b = await this.initStealthBrowser();
    const isMobile = env.playwrightMobileMode;
    const mobileViewport = {
      width: env.playwrightMobileViewportWidth,
      height: env.playwrightMobileViewportHeight,
    };
    return b.newContext({
      storageState,
      locale: "vi-VN",
      viewport: isMobile ? mobileViewport : { width: 1280, height: 800 },
      userAgent: isMobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
        : undefined,
      isMobile,
      hasTouch: isMobile,
      deviceScaleFactor: isMobile ? 2 : undefined,
    });
  }

  async safeDownload(
    page: Page,
    triggerDownload: () => Promise<void>,
    timeoutMs: number,
  ): Promise<Download> {
    return runWithTimeout("safeDownload:waitForEvent", timeoutMs, async () => {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: timeoutMs }),
        triggerDownload(),
      ]);
      return download;
    });
  }

  protected async runStep<T>(stepName: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    return runWithTimeout(stepName, timeoutMs, fn);
  }

  /**
   * Giải captcha → điền → submit (callback) → nếu sai: `preparePageForRetry` hoặc "Làm mới" captcha, lặp tối đa `maxAttempts` (mặc định 3).
   */
  async handleCaptchaWithRetry(opts: HandleCaptchaWithRetryOptions): Promise<void> {
    if (!this.captchaClient.isConfigured()) {
      throw new Error(
        "Thiếu ANTICAPTCHA_API_KEY trong .env — worker không thể gọi API anticaptcha.top để giải captcha.",
      );
    }

    const maxAttempts = opts.maxAttempts ?? 3;
    const { page, selectors, stepTimeoutMs } = opts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let lap = Date.now();
      const captchaTrace = (label: string) => {
        if (!env.npcLoginTraceTiming) return;
        const now = Date.now();
        console.info(`[captcha+timing] L${attempt}/${maxAttempts} ${label}: ${now - lap}ms`);
        lap = now;
      };

      logger.debug(`[captcha] Lần ${attempt}/${maxAttempts}: chờ ảnh captcha hiển thị...`);
      await this.runStep("captcha:waitImage", stepTimeoutMs, async () => {
        await page.waitForSelector(selectors.captchaImage, { state: "visible", timeout: stepTimeoutMs });
      });
      captchaTrace("waitImage (#CaptchaImage visible)");

      const captchaLocator = page.locator(selectors.captchaImage);
      const imageBase64 = opts.getImageBase64
        ? await this.runStep("captcha:getImageBase64", stepTimeoutMs, opts.getImageBase64)
        : (
            await this.runStep("captcha:screenshot", stepTimeoutMs, () =>
              captchaLocator.screenshot({ type: "png", animations: "disabled" }),
            )
          ).toString("base64");
      captchaTrace("screenshot/base64 ảnh captcha");

      logger.debug(
        `[captcha] Đã có dữ liệu ảnh (${Math.round(imageBase64.length / 1024)}KB base64), gọi API giải captcha...`,
      );

      const solution = await this.runStep("captcha:solveAPI", stepTimeoutMs, () =>
        this.captchaClient.solveImageCaptcha({ imageBase64, mimeType: "image/png" }),
      );
      captchaTrace("solveAPI (anticaptcha.top — thường chiếm hầu hết thời gian)");

      logger.debug(`[captcha] API trả mã (${solution.length} ký tự): điền vào ô và bấm tìm...`);

      await this.runStep("captcha:fill", stepTimeoutMs, async () => {
        const input = page.locator(selectors.captchaInput).first();
        await input.fill("");
        await input.fill(solution);
      });
      captchaTrace("fill ô captcha");

      const { shouldRetryCaptcha } = await this.runStep("captcha:submit", stepTimeoutMs, () => opts.submit());
      captchaTrace(`submit + đánh giá (retry=${shouldRetryCaptcha})`);

      if (!shouldRetryCaptcha) {
        return;
      }

      if (attempt < maxAttempts) {
        const prepare = opts.preparePageForRetry;
        if (prepare) {
          await this.runStep("captcha:preparePageForRetry", stepTimeoutMs, () => prepare());
        } else {
          await this.runStep("captcha:changeCode", stepTimeoutMs, async () => {
            await page.click(selectors.changeCodeButton, { timeout: stepTimeoutMs });
            await page.waitForTimeout(300);
          });
        }
        captchaTrace(prepare ? "preparePageForRetry" : "changeCode (làm mới captcha)");
      } else {
        throw new Error(`Captcha sai sau ${maxAttempts} lần (site vẫn báo cần thử lại)`);
      }
    }
  }

  async disposeBrowser(): Promise<void> {
    if (this.disposingBrowserPromise) {
      await this.disposingBrowserPromise;
      return;
    }
    const browserToClose = this.browser;
    this.browser = null;
    if (browserToClose) {
      this.disposingBrowserPromise = (async () => {
        await browserToClose.close().catch(() => undefined);
      })();
      try {
        await this.disposingBrowserPromise;
      } finally {
        this.disposingBrowserPromise = null;
      }
    }
    this.activeBrowserSessions = 0;
  }
}
