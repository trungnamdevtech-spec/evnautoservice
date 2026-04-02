import type { Page } from "playwright";
import type { HandleCaptchaWithRetryOptions } from "../../core/BaseWorker.js";
import { env } from "../../config/env.js";
import { hanoiSelectors } from "./hanoiSelectors.js";
import {
  HanoiLoginWrongCredentialsError,
  detectHanoiLoginErrorKind,
} from "./hanoiLoginErrors.js";

export type RunStepFn = <T>(name: string, timeoutMs: number, fn: () => Promise<T>) => Promise<T>;


function hanoiLoginTrace(label: string, t0: number): void {
  if (!env.hanoiLoginTraceTiming) return;
  console.info(`[hanoi-login+timing] ${label} — tổng ${Date.now() - t0}ms`);
}

/**
 * Đọc nội dung thông báo lỗi từ DOM sau khi submit.
 * EVN Hà Nội dùng Angular — thông báo có thể render sau vài trăm ms (mat-error, toast, …).
 */
async function readHanoiErrorMessage(page: Page): Promise<string> {
  const deadline = Date.now() + env.hanoiLoginErrorProbeMs;
  const selectors = [...hanoiSelectors.errorMessageCandidates];

  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
          const text = (await el.textContent({ timeout: 800 }).catch(() => "")) ?? "";
          const t = text.trim();
          if (t.length > 0) return t;
        }
      } catch {
        // thử selector tiếp
      }
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  return readHanoiErrorMessageLastResort(page);
}

/** Khi không khớp selector: gom dòng trong form/login có từ khóa lỗi thường gặp. */
async function readHanoiErrorMessageLastResort(page: Page): Promise<string> {
  const box = page.locator("form, .login, [class*='login'], app-root").first();
  if (!(await box.isVisible({ timeout: 1500 }).catch(() => false))) {
    return "";
  }
  const t = (await box.innerText({ timeout: 3000 }).catch(() => "")) ?? "";
  const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length > 500) continue;
    if (/sai|không đúng|không hợp lệ|thất bại|lỗi|khóa|khoá|vô hiệu|đăng nhập thất bại/i.test(line)) {
      return line;
    }
  }
  return "";
}

/**
 * Chờ sau click Đăng nhập: hoặc rời URL login, hoặc có node lỗi hiện (tránh đọc DOM quá sớm).
 */
async function waitForLoginRedirectOrErrorVisible(page: Page, stepTimeoutMs: number): Promise<void> {
  const max = Math.min(env.hanoiLoginPostSubmitMaxMs, stepTimeoutMs);
  await page
    .waitForFunction(
      () => {
        const h = window.location.href.toLowerCase();
        const leftLogin =
          !h.includes("/user/login") &&
          !h.includes("#/user/login") &&
          !h.includes("#/login");
        if (leftLogin) return true;
        const sels = [
          "p.alert-danger.error-message",
          ".alert-danger",
          "[role='alert']",
          "mat-error",
          ".mat-mdc-form-field-error",
          ".mat-error",
          ".text-danger",
          ".invalid-feedback",
          ".mat-mdc-snack-bar-label",
          "snack-bar-container",
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (!el) continue;
          const t = (el.textContent || "").trim();
          if (t.length > 0) {
            const st = window.getComputedStyle(el);
            if (st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0) {
              return true;
            }
          }
        }
        return false;
      },
      { timeout: max, polling: 200 },
    )
    .catch(() => undefined);
}

/**
 * Đang ở màn đăng nhập (URL chứa path login).
 */
export async function isOnHanoiLoginPage(page: Page): Promise<boolean> {
  const u = page.url().toLowerCase();
  const loginPath = new URL(env.evnHanoiLoginUrl).pathname.toLowerCase();
  return u.includes(loginPath) || u.endsWith("/user/login") || u.endsWith("/login");
}

/**
 * Dấu hiệu đã đăng nhập trên header/DOM (dùng cho trang chủ — không thể suy từ URL).
 */
async function hasHanoiLoggedInDomSignals(page: Page): Promise<boolean> {
  const logoutByRole = page
    .getByRole("link", { name: /đăng xuất/i })
    .or(page.getByRole("button", { name: /đăng xuất/i }));
  if (await logoutByRole.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    return true;
  }
  const selectors = [
    'a[href*="logout" i]',
    'a[href*="log-out" i]',
    'a[href*="/user/logout" i]',
  ];
  for (const sel of selectors) {
    if (await page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

/**
 * Đã đăng nhập (session hợp lệ trên trang hiện tại).
 *
 * Lưu ý: Trang chủ công khai **không** phải URL login — nếu chỉ mở `evnhanoi.vn` mà chưa đăng nhập,
 * không được coi là logged-in. Cần có tín hiệu DOM (Đăng xuất, …) hoặc probe qua `goto(evnHanoiLoginUrl)`
 * rồi dùng `!isOnHanoiLoginPage`.
 */
export async function isHanoiLoggedIn(page: Page): Promise<boolean> {
  if (await isOnHanoiLoginPage(page)) {
    return false;
  }
  if (await hasHanoiLoggedInDomSignals(page)) {
    return true;
  }
  try {
    const parsed = new URL(page.url());
    const path = (parsed.pathname || "/").replace(/\/$/, "") || "/";
    if (path === "/" || path === "") {
      return false;
    }
  } catch {
    // ignore
  }
  return true;
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
        "EVN Hà Nội: phản hồi gợi ý captcha nhưng không thấy ảnh/ô captcha trên trang — kiểm tra selector hoặc nội dung lỗi.",
      );
    }
  }

  hanoiLoginTrace("xong submit + đánh giá", t0);

  await runStep("hanoi:login:verifySession", stepTimeoutMs, async () => {
    // Chờ Angular redirect hoàn tất
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    if (await isOnHanoiLoginPage(page)) {
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

  if (env.hanoiLoginPostSubmitMinSettleMs > 0) {
    await new Promise<void>((r) => setTimeout(r, env.hanoiLoginPostSubmitMinSettleMs));
  }
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  await waitForLoginRedirectOrErrorVisible(page, stepTimeoutMs);
  await new Promise<void>((r) => setTimeout(r, 400));

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

  const stillOnLogin = await isOnHanoiLoginPage(page);
  if (stillOnLogin) {
    // EVN Hà Nội thường không có captcha — chỉ retry captcha khi thật sự có ô/ảnh captcha sau submit
    if (await hasCaptcha(page)) {
      return { shouldRetryCaptcha: true };
    }
    const errMsg2 = errMsg || (await readHanoiErrorMessage(page));
    throw new Error(
      `EVN Hà Nội: vẫn ở màn đăng nhập sau submit${errMsg2 ? ` — ${errMsg2}` : " — không đọc được thông báo lỗi (selector hoặc load chậm)"}.`,
    );
  }

  return { shouldRetryCaptcha: false };
}
