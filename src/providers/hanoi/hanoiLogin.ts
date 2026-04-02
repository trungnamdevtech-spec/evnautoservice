import type { Page } from "playwright";
import type { HandleCaptchaWithRetryOptions } from "../../core/BaseWorker.js";
import { env } from "../../config/env.js";
import { hanoiSelectors } from "./hanoiSelectors.js";
import {
  HanoiLoginWrongCredentialsError,
  detectHanoiLoginErrorKind,
} from "./hanoiLoginErrors.js";

export type RunStepFn = <T>(name: string, timeoutMs: number, fn: () => Promise<T>) => Promise<T>;

const HANOI_PROBE_MS = 3000;

function hanoiLoginTrace(label: string, t0: number): void {
  if (!env.hanoiLoginTraceTiming) return;
  console.info(`[hanoi-login+timing] ${label} — tổng ${Date.now() - t0}ms`);
}

/**
 * Đọc nội dung thông báo lỗi từ DOM sau khi submit.
 * EVN Hà Nội dùng Angular — thông báo lỗi có thể load async qua ngIf,
 * nên chờ tối đa HANOI_PROBE_MS.
 */
async function readHanoiErrorMessage(page: Page): Promise<string> {
  const probe = { timeout: HANOI_PROBE_MS };
  for (const sel of [hanoiSelectors.errorMessage, hanoiSelectors.errorMessageAlt]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible(probe).catch(() => false)) {
        const text = (await el.textContent(probe).catch(() => "")) ?? "";
        if (text.trim()) return text.trim();
      }
    } catch {
      // không tìm thấy selector → thử tiếp
    }
  }
  return "";
}

/**
 * Kiểm tra đã đăng nhập: Angular redirect về trang khác sau login thành công.
 * Heuristic: không còn ở /user/login hoặc /login.
 */
export async function isHanoiLoggedIn(page: Page): Promise<boolean> {
  const u = page.url().toLowerCase();
  const loginPath = new URL(env.evnHanoiLoginUrl).pathname.toLowerCase();
  return !u.includes(loginPath) && !u.endsWith("/user/login") && !u.endsWith("/login");
}

/**
 * Đóng popup/overlay sau đăng nhập nếu có.
 */
export async function dismissHanoiOverlayIfPresent(page: Page, stepTimeoutMs: number): Promise<void> {
  const t = Math.min(5_000, stepTimeoutMs);
  await new Promise<void>((r) => setTimeout(r, 300));
  for (const sel of hanoiSelectors.postLoginModalCloseCandidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      await btn.click({ timeout: t }).catch(() => undefined);
      await new Promise<void>((r) => setTimeout(r, 200));
      break;
    }
  }
}

/**
 * Điền form đăng nhập Angular (formcontrolname) — fill kích hoạt Angular change detection.
 */
async function fillHanoiCredentials(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  const u = page.locator(hanoiSelectors.username).first();
  const p = page.locator(hanoiSelectors.password).first();
  await u.fill("");
  await u.fill(username);
  await p.fill("");
  await p.fill(password);
}

/**
 * Chờ form đăng nhập Angular hiển thị đầy đủ.
 */
async function waitHanoiLoginForm(page: Page, stepTimeoutMs: number): Promise<void> {
  await page.locator(hanoiSelectors.username).first().waitFor({ state: "visible", timeout: stepTimeoutMs });
  await page.locator(hanoiSelectors.password).first().waitFor({ state: "visible", timeout: stepTimeoutMs });
}

/**
 * Kiểm tra captcha có hiển thị không (EVN Hà Nội hiện chưa có, nhưng giữ để handle sau).
 */
async function hasCaptcha(page: Page): Promise<boolean> {
  const sel = hanoiSelectors.captchaImage;
  return page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false);
}

/**
 * Luồng đăng nhập EVN Hà Nội:
 * 1. Goto trang login
 * 2. Chờ form Angular render
 * 3. Điền credentials
 * 4. Submit
 * 5. Phân tích kết quả (lỗi DOM / redirect)
 * 6. Nếu có captcha: delegate handleCaptchaWithRetry
 */
export async function loginHanoiInteractive(
  page: Page,
  username: string,
  password: string,
  runStep: RunStepFn,
  stepTimeoutMs: number,
  handleCaptchaWithRetry: (opts: HandleCaptchaWithRetryOptions) => Promise<void>,
): Promise<void> {
  const t0 = Date.now();
  hanoiLoginTrace("bắt đầu loginHanoiInteractive", t0);

  await runStep("hanoi:login:goto", stepTimeoutMs, async () => {
    await page.goto(env.evnHanoiLoginUrl, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs });
    // Chờ thêm để Angular khởi động
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  });
  hanoiLoginTrace("xong goto login page", t0);

  await runStep("hanoi:login:waitForm", stepTimeoutMs, async () => {
    await waitHanoiLoginForm(page, stepTimeoutMs);
  });
  hanoiLoginTrace("xong chờ form Angular", t0);

  await runStep("hanoi:login:fillUserPass", stepTimeoutMs, async () => {
    await fillHanoiCredentials(page, username, password);
  });
  hanoiLoginTrace("xong điền user/pass", t0);

  const withCaptcha = await hasCaptcha(page);

  if (withCaptcha) {
    hanoiLoginTrace("phát hiện captcha — vào handleCaptchaWithRetry", t0);
    await handleCaptchaWithRetry({
      page,
      selectors: {
        captchaImage: hanoiSelectors.captchaImage,
        captchaInput: hanoiSelectors.captchaInput,
        changeCodeButton: hanoiSelectors.captchaRefresh,
      },
      stepTimeoutMs,
      maxAttempts: env.hanoiCaptchaMaxAttempts,
      preparePageForRetry: async () => {
        await runStep("hanoi:login:prepareAfterCaptchaFail", stepTimeoutMs, async () => {
          await page.goto(env.evnHanoiLoginUrl, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs });
          await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
          await waitHanoiLoginForm(page, stepTimeoutMs);
          await fillHanoiCredentials(page, username, password);
        });
      },
      submit: () => submitAndEvaluate(page, stepTimeoutMs, t0),
    });
  } else {
    // Không có captcha — submit thẳng
    const result = await runStep("hanoi:login:submit", stepTimeoutMs, () =>
      submitAndEvaluate(page, stepTimeoutMs, t0),
    );
    if (result.shouldRetryCaptcha) {
      throw new Error(
        "EVN Hà Nội: submit báo lỗi captcha nhưng không tìm thấy ô captcha — kiểm tra lại selector.",
      );
    }
  }

  hanoiLoginTrace("xong submit + đánh giá", t0);

  await runStep("hanoi:login:verifySession", stepTimeoutMs, async () => {
    // Chờ Angular redirect hoàn tất
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    if (!(await isHanoiLoggedIn(page))) {
      const errMsg = await readHanoiErrorMessage(page);
      throw new Error(
        `EVN Hà Nội: vẫn ở màn đăng nhập sau submit${errMsg ? ` — ${errMsg}` : ""}`,
      );
    }
  });
  hanoiLoginTrace("xong verify session", t0);
}

async function submitAndEvaluate(
  page: Page,
  stepTimeoutMs: number,
  t0: number,
): Promise<{ shouldRetryCaptcha: boolean }> {
  const btn = page.locator(hanoiSelectors.submitButton).first();
  await btn.waitFor({ state: "visible", timeout: stepTimeoutMs });
  await btn.click({ timeout: stepTimeoutMs });

  // Chờ Angular xử lý response (network idle hoặc tối đa 5s)
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  await new Promise<void>((r) => setTimeout(r, 300));

  if (env.hanoiLoginTraceTiming) {
    console.info(`[hanoi-submit+timing] click Đăng nhập — tổng ${Date.now() - t0}ms`);
  }

  const errMsg = await readHanoiErrorMessage(page);
  if (errMsg) {
    const kind = detectHanoiLoginErrorKind(errMsg);
    if (kind === "wrong_password" || kind === "locked") {
      throw new HanoiLoginWrongCredentialsError(
        `EVN Hà Nội từ chối: ${errMsg.slice(0, 500)}`,
      );
    }
    if (kind === "captcha") {
      return { shouldRetryCaptcha: true };
    }
  }

  // Kiểm tra vẫn ở màn login (Angular ng-invalid, form còn hiển thị)
  const stillOnLogin = !(await isHanoiLoggedIn(page));
  if (stillOnLogin) {
    // Có thể captcha ẩn hoặc lỗi khác
    return { shouldRetryCaptcha: true };
  }

  return { shouldRetryCaptcha: false };
}
