/**
 * Chạy thử đăng nhập CSKH NPC — mở trình duyệt để theo dõi.
 * Không cần MongoDB / task queue. Dùng tài khoản trực tiếp trong code (chỉ cho dev).
 * 
 * Usage:
 *   npm run test:npc-login
 * 
 * Lưu ý: Cần có ANTICAPTCHA_API_KEY trong .env để giải captcha.
 * Tuỳ chọn: NPC_LOGIN_TRACE_TIMING=1 để xem log timing login/captcha.
 */
import "dotenv/config";
import { env } from "../config/env.js";

const STEP_MS = 90_000;

// Tài khoản test - chỉ dùng cho môi trường dev
const TEST_USERNAME = "PA25VY0071988";
const TEST_PASSWORD = "Vanhanh@123";

async function main(): Promise<void> {
  const { runWithTimeout } = await import("../core/stepTimeout.js");
  const { AnticaptchaClient } = await import("../services/captcha/AnticaptchaClient.js");
  const { BaseWorker } = await import("../core/BaseWorker.js");
  const { isStillOnNpcLoginPage, loginNpcInteractive } = await import("../providers/npc/npcLogin.js");

  const runStep = <T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> =>
    runWithTimeout(name, timeoutMs, fn);

  // Tạo một class tạm thời kế thừa BaseWorker để dùng handleCaptchaWithRetry
  class TestNPCWorker extends BaseWorker {
    async testLogin(page: any): Promise<void> {
      await loginNpcInteractive(
        page,
        TEST_USERNAME,
        TEST_PASSWORD,
        runStep,
        STEP_MS,
        (opts) => this.handleCaptchaWithRetry(opts),
      );
    }
  }

  const worker = new TestNPCWorker(new AnticaptchaClient());
  
  console.info("[test-npc-login] Khởi động trình duyệt (HEADLESS=false để quan sát)...");
  await worker.beginBrowserSession();
  
  const context = await worker.createDisposableContext();
  const page = await context.newPage();

  try {
    console.info("[test-npc-login] Bắt đầu đăng nhập NPC...");
    console.info(`[test-npc-login] URL: ${env.evnNpcLoginUrl}`);
    console.info(`[test-npc-login] Username: ${TEST_USERNAME}`);

    await worker.testLogin(page);

    if (!page.url().toLowerCase().includes("indexnpc") || (await isStillOnNpcLoginPage(page))) {
      throw new Error("loginNpcInteractive phải kết thúc tại IndexNPC — kiểm tra session / URL.");
    }

    console.info("[test-npc-login] ✓ Đã tới IndexNPC:", page.url());

    // Lưu storage state để kiểm tra
    const storage = await page.context().storageState();
    console.info("[test-npc-login] Storage state (cookies count):", storage.cookies?.length || 0);

  } catch (err) {
    console.error("[test-npc-login] ✗ Lỗi:", err instanceof Error ? err.message : err);
    throw err;
  } finally {
    console.info("[test-npc-login] Đang đợi 10 giây để quan sát trước khi đóng...");
    await new Promise((r) => setTimeout(r, 15000));
    
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await worker.endBrowserSession();
    console.info("[test-npc-login] Đã đóng trình duyệt.");
  }
}

main().catch((err) => {
  console.error("[test-npc-login] Lỗi không xử lý được:", err instanceof Error ? err.message : err);
  process.exit(1);
});
