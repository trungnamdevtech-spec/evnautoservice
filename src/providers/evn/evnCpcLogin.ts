import type { Page } from "playwright";
import { env } from "../../config/env.js";
import { evnCpcSelectors } from "./evnCpcSelectors.js";
import {
  assertLoginApiAllowsSession,
  parseCheckExistUserResponse,
} from "./checkExistUserApi.js";

export type RunStepFn = <T>(name: string, timeoutMs: number, fn: () => Promise<T>) => Promise<T>;

/**
 * Đăng nhập CSKH CPC — dùng biến môi trường, không hardcode mật khẩu trong mã.
 * Sau khi bấm Đăng nhập, site gọi API `check-exist-user`; ta đọc JSON để biết sai user/mật khẩu.
 * Thành công API → chờ URL rời `/dang-nhap`.
 */
export async function loginEvnCpc(page: Page, runStep: RunStepFn, stepTimeoutMs: number): Promise<void> {
  const user = env.evnCpcLoginUsername.trim();
  const pass = env.evnCpcLoginPassword;
  if (!user || !pass) {
    throw new Error(
      "Thiếu EVN_CPC_LOGIN_USERNAME / EVN_CPC_LOGIN_PASSWORD — bổ sung trong .env hoặc truyền session qua task.sessionData",
    );
  }

  const loginForm = page.locator('form:has(input[name="username"])');
  const apiMatch = env.evnCpcCheckExistUserUrlMatch;

  await runStep("evn:login:goto", stepTimeoutMs, async () => {
    await page.goto(env.evnCpcLoginUrl, { waitUntil: "domcontentloaded", timeout: stepTimeoutMs });
  });

  await runStep("evn:login:waitForm", stepTimeoutMs, async () => {
    await page.locator(evnCpcSelectors.loginUsername).waitFor({ state: "visible", timeout: stepTimeoutMs });
    await page.locator(evnCpcSelectors.loginPassword).waitFor({ state: "visible", timeout: stepTimeoutMs });
  });

  await runStep("evn:login:fill", stepTimeoutMs, async () => {
    await page.locator(evnCpcSelectors.loginUsername).fill("");
    await page.locator(evnCpcSelectors.loginUsername).fill(user);
    await page.locator(evnCpcSelectors.loginPassword).fill("");
    await page.locator(evnCpcSelectors.loginPassword).fill(pass);
  });

  await runStep("evn:login:submit", stepTimeoutMs, async () => {
    const submit = loginForm.locator(evnCpcSelectors.loginSubmitButton).first();

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(apiMatch) && r.status() < 500,
        { timeout: stepTimeoutMs },
      ),
      submit.click({ timeout: stepTimeoutMs }),
    ]);

    const body = await parseCheckExistUserResponse(response);
    assertLoginApiAllowsSession(body);

    await page.waitForURL(
      (url) => !url.pathname.toLowerCase().includes("dang-nhap"),
      { timeout: stepTimeoutMs },
    );
  });
}
