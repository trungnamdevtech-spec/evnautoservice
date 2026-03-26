/**
 * Chạy thử đăng nhập CSKH CPC — không cần MongoDB / task queue.
 * Usage:
 *   npm run test:login
 *   npm run test:login:wrong   (gán mật khẩu sai tạm để thử xử lý lỗi)
 */
import "dotenv/config";
import { env } from "../config/env.js";

const wrong = process.argv.includes("--wrong");
if (wrong) {
  process.env.EVN_CPC_LOGIN_PASSWORD = "__WRONG_PASSWORD_TEST__";
}

const STEP_MS = 90_000;

async function main(): Promise<void> {
  const { runWithTimeout } = await import("../core/stepTimeout.js");
  const { AnticaptchaClient } = await import("../services/captcha/AnticaptchaClient.js");
  const { EVNCPCWorker } = await import("../providers/evn/EVNCPCWorker.js");
  const { loginEvnCpc } = await import("../providers/evn/evnCpcLogin.js");

  const runStep = <T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> =>
    runWithTimeout(name, timeoutMs, fn);

  const worker = new EVNCPCWorker(new AnticaptchaClient());
  await worker.beginBrowserSession();
  const context = await worker.createDisposableContext();
  const page = await context.newPage();

  try {
    if (wrong) {
      console.info("[test-login] Chế độ sai mật khẩu (mật khẩu tạm, không đọc .env).");
    }
    console.info("[test-login] Bắt đầu đăng nhập...");
    await loginEvnCpc(page, runStep, STEP_MS);
    console.info("[test-login] Thành công. URL:", page.url());
  } finally {
    if (env.playwrightPauseBeforeCloseMs > 0) {
      console.info(
        `[playwright] Tạm dừng ${env.playwrightPauseBeforeCloseMs}ms trước khi đóng trang (PLAYWRIGHT_PAUSE_BEFORE_CLOSE_MS)...`,
      );
      await new Promise((r) => setTimeout(r, env.playwrightPauseBeforeCloseMs));
    }
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await worker.endBrowserSession();
  }
}

main().catch((err) => {
  console.error("[test-login] Lỗi:", err instanceof Error ? err.message : err);
  process.exit(1);
});
