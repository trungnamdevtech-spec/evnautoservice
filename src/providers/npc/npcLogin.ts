import type { Page } from "playwright";
import type { HandleCaptchaWithRetryOptions } from "../../core/BaseWorker.js";
import { env } from "../../config/env.js";
import { npcSelectors } from "./npcSelectors.js";
import { detectNpcSsrErrorKindFromHtml } from "./npcLoginHtmlErrors.js";
import { NpcLoginWrongCredentialsError } from "./npcLoginErrors.js";

export type RunStepFn = <T>(name: string, timeoutMs: number, fn: () => Promise<T>) => Promise<T>;

/** Sau redirect đăng nhập, form có thể đã biến mất — không dùng timeout mặc định (~30s) trên mỗi locator. */
const NPC_LOGIN_PROBE_MS = 2000;

/**
 * Vẫn trong luồng đăng nhập: URL Account/Login, hoặc có cổng chọn "Mã Khách hàng" (#btnTaiKhoan),
 * hoặc form #login-form hiển thị.
 */
export async function isStillOnNpcLoginPage(page: Page): Promise<boolean> {
  const u = page.url().toLowerCase();
  if (u.includes("accountnpc") || u.includes("/account/login")) return true;
  const probe = { timeout: NPC_LOGIN_PROBE_MS } as const;
  if (await page.locator(npcSelectors.btnTaiKhoan).isVisible(probe).catch(() => false)) return true;
  return page.locator(npcSelectors.loginForm).isVisible(probe).catch(() => false);
}

/** Đã rời màn đăng nhập và không còn hiển thị như khách vãng lai trên trang chủ (heuristic session). */
export async function isLikelyNpcLoggedInSession(page: Page): Promise<boolean> {
  if (await isStillOnNpcLoginPage(page)) return false;
  if (await isNpcGuestOnMarketingHome(page)) return false;
  return true;
}

/**
 * Sau khi POST login, server đôi khi đưa về `/` hoặc `/home` dù chưa có session (captcha sai).
 * Heuristic: trang chủ + có link vào AccountNPC + không thấy gợi ý đã đăng nhập.
 */
export async function isNpcGuestOnMarketingHome(page: Page): Promise<boolean> {
  const u = page.url().toLowerCase();
  if (!u.includes("cskh.npc.com.vn")) return false;
  const path = new URL(page.url()).pathname.toLowerCase();
  if (path !== "/" && path !== "/home" && path !== "/home/") return false;

  const probe = { timeout: NPC_LOGIN_PROBE_MS } as const;
  const looksLoggedIn = await page
    .getByText(/đăng xuất|thoát|tài khoản của tôi/i)
    .first()
    .isVisible(probe)
    .catch(() => false);
  if (looksLoggedIn) return false;

  const hasLoginEntry = await page
    .locator(
      'header a[href*="AccountNPC"], header a[href*="accountnpc"], header a[href*="Account/Login"], nav a[href*="AccountNPC"], nav a[href*="Account/Login"]',
    )
    .first()
    .isVisible(probe)
    .catch(() => false);
  return hasLoginEntry;
}

function looksLikeCaptchaError(msg: string): boolean {
  return /captcha|kiểm tra|mã hình|hình ảnh|mã xác nhận/i.test(msg);
}

function looksLikeAuthError(msg: string): boolean {
  return /mật khẩu|đăng nhập|sai|không đúng|tài khoản/i.test(msg);
}

function npcLoginTrace(label: string, t0: number): void {
  if (!env.npcLoginTraceTiming) return;
  console.info(`[npc-login+timing] ${label} — tổng ${Date.now() - t0}ms`);
}

/**
 * Bước bắt buộc: click nút "Mã Khách hàng sử dụng điện" (#btnTaiKhoan) mới hiện form đăng nhập đầy đủ.
 * @see https://cskh.npc.com.vn/home/AccountNPC
 */
async function clickBtnTaiKhoan(page: Page, stepTimeoutMs: number): Promise<void> {
  const btn = page.locator(npcSelectors.btnTaiKhoan);
  await btn.waitFor({ state: "visible", timeout: stepTimeoutMs });
  await btn.click({ timeout: stepTimeoutMs });
  await page.waitForLoadState("domcontentloaded", { timeout: stepTimeoutMs }).catch(() => undefined);
  await new Promise<void>((r) => setTimeout(r, 500));
}

async function waitNpcLoginForm(page: Page, stepTimeoutMs: number): Promise<void> {
  await page.locator(npcSelectors.loginForm).waitFor({ state: "visible", timeout: stepTimeoutMs });
  await page.locator(npcSelectors.username).waitFor({ state: "visible", timeout: stepTimeoutMs });
  await page.locator(npcSelectors.password).waitFor({ state: "visible", timeout: stepTimeoutMs });
}

async function fillNpcCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.locator(npcSelectors.username).fill("");
  await page.locator(npcSelectors.username).fill(username);
  await page.locator(npcSelectors.password).fill("");
  await page.locator(npcSelectors.password).fill(password);
}

/**
 * NPC captcha: chụp màn hình đúng vùng captcha đang hiển thị trên page.
 * Không dùng request URL/canvas để tránh lệch ngữ cảnh phiên.
 */
async function getNpcCaptchaImageBase64(page: Page, stepTimeoutMs: number): Promise<string> {
  const sel = npcSelectors.captchaImage;
  const loc = page.locator(sel).first();

  await loc.waitFor({ state: "visible", timeout: stepTimeoutMs });

  await page
    .evaluate((s) => {
      const el = document.querySelector(s);
      const img = el instanceof HTMLImageElement ? el : null;
      if (!img) return Promise.resolve();
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const done = () => resolve();
        const fail = () => reject(new Error("NPC captcha image failed to load"));
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", fail, { once: true });
      });
    }, sel)
    .catch(() => undefined);

  const captchaToken = (await page.locator("#CaptchaDeText").first().inputValue().catch(() => "")) ?? "";
  const captureId = "__npc_captcha_capture_overlay__";
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(80);
    const scale = env.npcCaptchaImageScale;
    const minHeightPx = env.npcCaptchaImageMinHeightPx;
    await page.evaluate(
      ({ imageSelector, overlayId, scale: s, minHeightPx: minH }) => {
        document.getElementById(overlayId)?.remove();

        const srcEl = document.querySelector(imageSelector);
        if (!(srcEl instanceof HTMLImageElement)) {
          throw new Error("Captcha image element not found");
        }

        const overlay = document.createElement("div");
        overlay.id = overlayId;
        overlay.style.position = "fixed";
        overlay.style.left = "16px";
        overlay.style.top = "16px";
        overlay.style.padding = "8px";
        overlay.style.background = "#fff";
        overlay.style.border = "1px solid rgba(0,0,0,.15)";
        overlay.style.zIndex = "2147483647";
        overlay.style.pointerEvents = "none";

        let w = Math.max(1, Math.round(srcEl.clientWidth * s));
        let h = Math.max(1, Math.round(srcEl.clientHeight * s));
        if (minH > 0 && h < minH) {
          const f = minH / h;
          w = Math.max(1, Math.round(w * f));
          h = Math.max(1, Math.round(h * f));
        }

        const enlarged = document.createElement("img");
        enlarged.src = srcEl.currentSrc || srcEl.src;
        enlarged.alt = "npc-captcha-capture";
        enlarged.style.width = `${w}px`;
        enlarged.style.height = `${h}px`;
        enlarged.style.display = "block";
        enlarged.style.imageRendering = "auto";

        overlay.appendChild(enlarged);
        document.body.appendChild(overlay);
      },
      { imageSelector: sel, overlayId: captureId, scale, minHeightPx },
    );

    const overlay = page.locator(`#${captureId}`);
    await overlay.waitFor({ state: "visible", timeout: stepTimeoutMs });
    const box = await overlay.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error("Không lấy được vùng captcha phóng to để chụp màn hình.");
    }
    if (env.npcLoginTraceTiming) {
      console.info(
        `[npc-captcha] clip=${Math.round(box.width)}x${Math.round(box.height)} token=${captchaToken || "(empty)"} (scale=${scale}, minH=${minHeightPx || "off"})`,
      );
    }

    const buf = await page.screenshot({
      type: "png",
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: Math.max(1, box.width),
        height: Math.max(1, box.height),
      },
      animations: "disabled",
      timeout: stepTimeoutMs,
    });
    return buf.toString("base64");
  } finally {
    await page
      .evaluate((overlayId) => {
        document.getElementById(overlayId)?.remove();
      }, captureId)
      .catch(() => undefined);
  }
}

/** UIkit: đóng popup thật bằng nút close và parent modal/dialog tương ứng. */
async function hideUkOpenModalViaPageJs(page: Page): Promise<void> {
  await page
    .evaluate((selectors) => {
      const g = globalThis as unknown as {
        UIkit?: { modal?: (el: Element) => { hide: () => void } };
      };
      const closeBtn = document.querySelector(selectors.closeBtn);
      const dialogByImage = document.querySelector(selectors.popupImage)?.closest(selectors.popupDialog);
      const dialog = dialogByImage ?? closeBtn?.closest(selectors.popupDialog) ?? closeBtn?.parentElement;
      const rootModal = dialog?.closest(".uk-modal") ?? document.querySelector(".uk-modal.uk-open");

      const hideEl = (el: Element | null | undefined) => {
        if (!el) return;
        if (g.UIkit?.modal) {
          try {
            g.UIkit.modal(el).hide();
          } catch {
            /* ignore */
          }
        }
        if (el instanceof HTMLElement) {
          el.style.display = "none";
          el.classList.remove("uk-open");
        }
      };

      hideEl(rootModal);
      hideEl(dialog);
      closeBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }, {
      closeBtn: ".uk-modal-dialog button.uk-modal-close-default.uk-close, button.uk-modal-close-default.uk-close",
      popupDialog: npcSelectors.postLoginPopupDialog,
      popupImage: npcSelectors.postLoginPopupImage,
    })
    .catch(() => undefined);
  await new Promise<void>((r) => setTimeout(r, 150));
}

/** Khi UIkit không phản hồi — gỡ đúng dialog popup ảnh cảnh báo khỏi DOM để không chặn `goto`. */
async function bruteForceHideUkMarketingLayer(page: Page): Promise<void> {
  await page
    .evaluate((selectors) => {
      const dialogs = new Set<Element>();

      document.querySelectorAll<HTMLElement>(".uk-modal.uk-open").forEach((el) => dialogs.add(el));
      document.querySelectorAll<HTMLImageElement>(selectors.popupImage).forEach((img) => {
        const dialog = img.closest(selectors.popupDialog);
        if (dialog) dialogs.add(dialog);
      });
      document.querySelectorAll(selectors.closeBtn).forEach((btn) => {
        const dialog = btn.closest(selectors.popupDialog);
        if (dialog) dialogs.add(dialog);
      });

      dialogs.forEach((el) => {
        if (el instanceof HTMLElement) {
          el.classList.remove("uk-open");
          el.style.display = "none";
        }
        el.remove?.();
      });

      document.querySelectorAll(".uk-overlay.uk-open, .uk-modal-page, bottom-sheet-container").forEach((el) => {
        if (el instanceof HTMLElement) {
          el.style.display = "none";
          el.classList.remove("uk-open");
        }
        el.remove?.();
      });
    }, {
      closeBtn: ".uk-modal-dialog button.uk-modal-close-default.uk-close, button.uk-modal-close-default.uk-close",
      popupDialog: npcSelectors.postLoginPopupDialog,
      popupImage: npcSelectors.postLoginPopupImage,
    })
    .catch(() => undefined);
}

/**
 * Sau đăng nhập, CSKH NPC có thể hiện popup cảnh báo (vd. tiền điện) che toàn trang — phải đóng mới `goto`/click tiếp được.
 */
export async function dismissNpcOverlayModalIfPresent(page: Page, stepTimeoutMs: number): Promise<void> {
  const t = Math.min(10_000, stepTimeoutMs);
  await new Promise<void>((r) => setTimeout(r, 200));

  await hideUkOpenModalViaPageJs(page);

  for (const sel of npcSelectors.postLoginModalCloseCandidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn
        .click({ timeout: t })
        .catch(async () => {
          await btn.click({ timeout: t, force: true }).catch(() => undefined);
        });
      await new Promise<void>((r) => setTimeout(r, 180));
      break;
    }
  }

  const preciseCloseBtn = page.locator(".uk-modal-dialog button.uk-modal-close-default.uk-close").first();
  if (await preciseCloseBtn.isVisible().catch(() => false)) {
    await preciseCloseBtn.click({ timeout: t }).catch(() => undefined);
    await preciseCloseBtn.click({ timeout: t, force: true }).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 180));
  }

  const xBtn = page.getByRole("button", { name: /^×|✕$/ }).first();
  if (await xBtn.isVisible().catch(() => false)) {
    await xBtn.click({ timeout: t }).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 250));
  }

  await hideUkOpenModalViaPageJs(page);

  await page.keyboard.press("Escape").catch(() => undefined);
  await new Promise<void>((r) => setTimeout(r, 200));
  await page.keyboard.press("Escape").catch(() => undefined);
  await new Promise<void>((r) => setTimeout(r, 150));

  await bruteForceHideUkMarketingLayer(page);
}

/**
 * Điền user/pass + giải captcha (qua BaseWorker.handleCaptchaWithRetry) — submit trong callback.
 * Khi đăng nhập thành công site thường redirect về `https://cskh.npc.com.vn/`.
 * Sai captcha: HTML SSR có thể chứa `Mã xác thực không chính xác` — retry tối đa `env.npcCaptchaMaxAttempts` (mặc định 5).
 * Sai mật khẩu: HTML có `Tài khoản/mật khẩu không chính xác` — ném NpcLoginWrongCredentialsError (không nhầm với captcha).
 */
export async function loginNpcInteractive(
  page: Page,
  username: string,
  password: string,
  runStep: RunStepFn,
  stepTimeoutMs: number,
  handleCaptchaWithRetry: (opts: HandleCaptchaWithRetryOptions) => Promise<void>,
): Promise<void> {
  const t0 = Date.now();
  npcLoginTrace("bắt đầu loginNpcInteractive", t0);

  await runStep("npc:login:goto", stepTimeoutMs, async () => {
    await page.goto(env.evnNpcLoginUrl, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs });
  });
  npcLoginTrace("xong goto AccountNPC", t0);

  await runStep("npc:login:btnTaiKhoan", stepTimeoutMs, async () => {
    await clickBtnTaiKhoan(page, stepTimeoutMs);
  });
  npcLoginTrace("xong click btnTaiKhoan", t0);

  await runStep("npc:login:waitForm", stepTimeoutMs, async () => {
    await waitNpcLoginForm(page, stepTimeoutMs);
  });
  npcLoginTrace("xong chờ form đăng nhập", t0);

  await runStep("npc:login:fillUserPass", stepTimeoutMs, async () => {
    await fillNpcCredentials(page, username, password);
  });
  npcLoginTrace("xong điền user/pass — sắp vào handleCaptchaWithRetry", t0);

  await handleCaptchaWithRetry({
    page,
    selectors: {
      captchaImage: npcSelectors.captchaImage,
      captchaInput: npcSelectors.captchaInput,
      changeCodeButton: npcSelectors.captchaRefresh,
    },
    stepTimeoutMs,
    maxAttempts: env.npcCaptchaMaxAttempts,
    getImageBase64: () => getNpcCaptchaImageBase64(page, stepTimeoutMs),
    preparePageForRetry: async () => {
      await runStep("npc:login:prepareAfterCaptchaFail", stepTimeoutMs, async () => {
        await page.goto(env.evnNpcLoginUrl, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs });
        await clickBtnTaiKhoan(page, stepTimeoutMs);
        await waitNpcLoginForm(page, stepTimeoutMs);
        await fillNpcCredentials(page, username, password);
      });
    },
    submit: async () => {
      if (env.npcLoginTraceTiming) {
        console.info(`[npc-submit+timing] click Đăng nhập — tổng ${Date.now() - t0}ms`);
      }
      await page.locator(npcSelectors.submitButton).click({ timeout: stepTimeoutMs });
      /**
       * Giới hạn ngắn: cookie đã set từ response login; không chờ full `domcontentloaded` trang chủ + popup (có thể rất lâu).
       */
      await page.waitForLoadState("domcontentloaded", { timeout: 2500 }).catch(() => undefined);
      await new Promise<void>((r) => setTimeout(r, 200));

      const html = await page.content().catch(() => "");
      const ssrKind = detectNpcSsrErrorKindFromHtml(html);
      if (ssrKind === "wrong_password") {
        throw new NpcLoginWrongCredentialsError();
      }
      if (ssrKind === "wrong_captcha") {
        return { shouldRetryCaptcha: true };
      }

      const probe = { timeout: NPC_LOGIN_PROBE_MS } as const;
      const err =
        (await page.locator(npcSelectors.formErrorParagraph).textContent(probe).catch(() => ""))?.trim() ?? "";
      const fieldErr =
        (await page.locator('[data-valmsg-for="CaptchaInputText"]').textContent(probe).catch(() => ""))?.trim() ??
        "";
      const combined = `${err} ${fieldErr}`.trim();

      if (combined && looksLikeAuthError(combined) && !looksLikeCaptchaError(combined)) {
        throw new NpcLoginWrongCredentialsError(`Đăng nhập NPC từ chối: ${combined.slice(0, 500)}`);
      }

      if (await isStillOnNpcLoginPage(page)) {
        if (env.npcLoginTraceTiming) {
          console.info(`[npc-submit+timing] cần retry captcha (vẫn màn đăng nhập) — tổng ${Date.now() - t0}ms`);
        }
        return { shouldRetryCaptcha: true };
      }

      if (await isNpcGuestOnMarketingHome(page)) {
        if (env.npcLoginTraceTiming) {
          console.info(`[npc-submit+timing] cần retry captcha (trang chủ khách) — tổng ${Date.now() - t0}ms`);
        }
        return { shouldRetryCaptcha: true };
      }

      if (env.npcLoginTraceTiming) {
        console.info(`[npc-submit+timing] xong đánh giá sau submit (không retry) — tổng ${Date.now() - t0}ms`);
      }
      return { shouldRetryCaptcha: false };
    },
  });
  npcLoginTrace("xong handleCaptchaWithRetry (captcha + submit)", t0);

  /**
   * Không đóng popup trên trang chủ trước — `goto` là navigation mới, không phụ thuộc overlay.
   * Session cookie đã có sau POST `/Account/Login` → chạy thẳng IndexNPC ngay.
   */
  await runStep("npc:login:gotoIndexNpcDirect", stepTimeoutMs, async () => {
    await page.goto(env.evnNpcIndexNpcUrl, { waitUntil: "commit", timeout: stepTimeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 200));
  });
  npcLoginTrace("xong goto IndexNPC", t0);

  await runStep("npc:login:dismissModalOnIndexNpc", stepTimeoutMs, async () => {
    await dismissNpcOverlayModalIfPresent(page, stepTimeoutMs);
  });
  npcLoginTrace("xong dismiss modal trên IndexNPC (nếu có)", t0);

  await runStep("npc:login:verifyIndexNpc", stepTimeoutMs, async () => {
    const u = page.url().toLowerCase();
    if (!u.includes("indexnpc")) {
      throw new Error("NPC: không điều hướng được tới DichVuTTCSKH/IndexNPC.");
    }
    if (await isStillOnNpcLoginPage(page)) {
      throw new Error("NPC: IndexNPC vẫn hiển thị màn đăng nhập — session có thể không hợp lệ.");
    }
  });
  npcLoginTrace("xong verify IndexNPC", t0);
}
