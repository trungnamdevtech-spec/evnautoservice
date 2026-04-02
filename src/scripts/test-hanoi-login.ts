/**
 * Chạy thử đăng nhập EVN Hà Nội — mở trình duyệt để theo dõi.
 * Không cần MongoDB / task queue. Dùng tài khoản trực tiếp trong code (chỉ cho dev).
 *
 * Usage:
 *   npm run test:hanoi-login
 *
 * Lưu ý: Nếu site có captcha, cần ANTICAPTCHA_API_KEY trong .env để giải.
 * Tuỳ chọn: HANOI_LOGIN_TRACE_TIMING=1 để xem log timing.
 */
import "dotenv/config";
import { env } from "../config/env.js";

const STEP_MS = 90_000;

// Tài khoản test — chỉ dùng cho môi trường dev
const TEST_USERNAME = process.env.HANOI_TEST_USERNAME ?? "";
const TEST_PASSWORD = process.env.HANOI_TEST_PASSWORD ?? "";

async function main(): Promise<void> {
  if (!TEST_USERNAME || !TEST_PASSWORD) {
    console.error(
      "[test-hanoi-login] Cần đặt HANOI_TEST_USERNAME và HANOI_TEST_PASSWORD trong .env để test.",
    );
    process.exit(1);
  }

  const { runWithTimeout } = await import("../core/stepTimeout.js");
  const { AnticaptchaClient } = await import("../services/captcha/AnticaptchaClient.js");
  const { BaseWorker } = await import("../core/BaseWorker.js");
  const { loginHanoiInteractive, isOnHanoiLoginPage } = await import("../providers/hanoi/hanoiLogin.js");

  const runStep = <T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> =>
    runWithTimeout(name, timeoutMs, fn);

  class TestHanoiWorker extends BaseWorker {
    async testLogin(page: import("playwright").Page): Promise<void> {
      await loginHanoiInteractive(
        page,
        TEST_USERNAME,
        TEST_PASSWORD,
        runStep,
        STEP_MS,
        (opts) => this.handleCaptchaWithRetry(opts),
      );
    }
  }

  const worker = new TestHanoiWorker(new AnticaptchaClient());

  console.info("[test-hanoi-login] Khởi động trình duyệt (PLAYWRIGHT_HEADLESS=false để quan sát)...");
  console.info(`[test-hanoi-login] URL: ${env.evnHanoiLoginUrl}`);
  console.info(`[test-hanoi-login] Username: ${TEST_USERNAME}`);

  await worker.beginBrowserSession();
  const context = await worker.createDisposableContext();
  const page = await context.newPage();

  try {
    await worker.testLogin(page);

    if (await isOnHanoiLoginPage(page)) {
      throw new Error("loginHanoiInteractive kết thúc nhưng vẫn ở màn đăng nhập — kiểm tra session.");
    }

    console.info("[test-hanoi-login] Đăng nhập thành công. URL hiện tại:", page.url());

    const storage = await page.context().storageState();
    console.info("[test-hanoi-login] Storage state (cookies):", storage.cookies?.length ?? 0, "cookie(s)");
    console.info("[test-hanoi-login] Storage state (origins):", storage.origins?.length ?? 0, "origin(s)");
  } catch (err) {
    console.error("[test-hanoi-login] Lỗi:", err instanceof Error ? err.message : err);
    throw err;
  } finally {
    console.info("[test-hanoi-login] Đợi 15 giây để quan sát trước khi đóng...");
    await new Promise((r) => setTimeout(r, 15_000));

    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await worker.endBrowserSession();
    console.info("[test-hanoi-login] Đã đóng trình duyệt.");
  }
}

main().catch((err) => {
  console.error("[test-hanoi-login] Lỗi không xử lý được:", err instanceof Error ? err.message : err);
  process.exit(1);
});
