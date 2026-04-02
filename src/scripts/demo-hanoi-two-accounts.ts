/**
 * Demo 2 tài khoản EVN Hà Nội — mở Chromium (không headless) để theo dõi đăng nhập Playwright.
 *
 * Cần: MONGODB_URI, HANOI_CREDENTIALS_SECRET, ANTICAPTCHA_API_KEY (nếu site có captcha)
 *
 * Chọn tài khoản (một trong hai):
 *   - HANOI_DEMO_USERNAMES=0868555326,PD22000022307  (đúng 2 username trong DB)
 *   - Bỏ trống → lấy 2 tài khoản enabled đầu tiên (sort username)
 *
 * Thời gian chờ sau mỗi lần đăng nhập (để xem trang): DEMO_HANOI_PAUSE_MS (mặc định 90000)
 * Khi lỗi (kể cả báo lỗi quá sớm khi trang đang redirect): DEMO_HANOI_PAUSE_ON_ERROR_MS — giữ tab mở thêm
 * trước khi đóng (mặc định = DEMO_HANOI_PAUSE_MS). DEMO_HANOI_KEEP_BROWSER_ON_ERROR=true → không gọi
 * endBrowserSession (Chromium vẫn mở; thoát bằng Ctrl+C).
 *
 * Usage (PowerShell):
 *   $env:PLAYWRIGHT_HEADLESS="false"; $env:HANOI_USE_API_LOGIN="false"; npm run demo:hanoi-two-accounts
 *
 * Hoặc đặt tạm trong .env: PLAYWRIGHT_HEADLESS=false, HANOI_USE_API_LOGIN=false rồi:
 *   npm run demo:hanoi-two-accounts
 */
import "dotenv/config";
import type { HanoiAccount } from "../types/hanoiAccount.js";

process.env.PLAYWRIGHT_HEADLESS = "false";
process.env.HANOI_USE_API_LOGIN = "false";
if (!process.env.DEMO_HANOI_PAUSE_MS?.trim()) {
  process.env.DEMO_HANOI_PAUSE_MS = "90000";
}
if (!process.env.PLAYWRIGHT_PAUSE_BEFORE_CLOSE_MS?.trim()) {
  process.env.PLAYWRIGHT_PAUSE_BEFORE_CLOSE_MS = "3000";
}

async function main(): Promise<void> {
  const { env } = await import("../config/env.js");
  const { AnticaptchaClient } = await import("../services/captcha/AnticaptchaClient.js");
  const { EVNHanoiWorker } = await import("../providers/hanoi/EVNHanoiWorker.js");
  const { HanoiAccountRepository } = await import("../db/hanoiAccountRepository.js");
  const { decryptHanoiPassword } = await import("../services/crypto/hanoiCredentials.js");
  const { normalizeStorageState } = await import("../core/BaseWorker.js");

  const secret = env.hanoiCredentialsSecret.trim();
  if (!secret) {
    console.error("[demo-hanoi-2] Thiếu HANOI_CREDENTIALS_SECRET");
    process.exit(1);
  }

  const pauseMs = Math.max(5000, parseInt(process.env.DEMO_HANOI_PAUSE_MS ?? "90000", 10) || 90000);
  const repo = new HanoiAccountRepository();

  const rawNames = (process.env.HANOI_DEMO_USERNAMES ?? "").trim();
  let accounts: HanoiAccount[];

  if (rawNames) {
    const parts = rawNames.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length !== 2) {
      console.error("[demo-hanoi-2] HANOI_DEMO_USERNAMES cần đúng 2 username, cách nhau bởi dấu phẩy.");
      process.exit(1);
    }
    const picked: HanoiAccount[] = [];
    for (const u of parts) {
      const a = await repo.findByUsername(u);
      if (!a) {
        console.error(`[demo-hanoi-2] Không tìm thấy tài khoản: ${u}`);
        process.exit(1);
      }
      if (!a.enabled || a.disabledReason === "wrong_password") {
        console.error(`[demo-hanoi-2] Tài khoản không dùng được: ${u}`);
        process.exit(1);
      }
      picked.push(a);
    }
    accounts = picked;
  } else {
    const batch = await repo.listEnabled(0, 2);
    if (batch.length < 2) {
      console.error("[demo-hanoi-2] Cần ít nhất 2 tài khoản enabled trong DB (hoặc đặt HANOI_DEMO_USERNAMES).");
      process.exit(1);
    }
    accounts = batch.slice(0, 2);
  }

  console.info("[demo-hanoi-2] PLAYWRIGHT_HEADLESS=false, HANOI_USE_API_LOGIN=false");
  console.info(
    `[demo-hanoi-2] Sẽ đăng nhập lần lượt: ${accounts.map((a) => a.username).join(" → ")}`,
  );
  console.info(`[demo-hanoi-2] Sau mỗi lần đăng nhập chờ ${pauseMs}ms — đổi DEMO_HANOI_PAUSE_MS nếu cần.`);

  const worker = new EVNHanoiWorker(new AnticaptchaClient());
  const step = env.hanoiStepTimeoutMs;
  let skipEndBrowserSession = false;

  try {
    await worker.beginBrowserSession();

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i]!;
      const accountId = account._id!;
      const password = decryptHanoiPassword(account.passwordEncrypted, secret);
      const traceId = `demo-hanoi-${Date.now()}-${i}`;

      console.info(`\n[demo-hanoi-2] —— (${i + 1}/2) ${account.username} ——`);

      const ctx = await worker.createDisposableContext(
        normalizeStorageState(account.storageStateJson ?? undefined),
      );
      const page = await ctx.newPage();

      let keepBrowserOnError = false;
      try {
        try {
          await worker.prepareHanoiSession(page, account, accountId, password, traceId, step);
          console.info(`[demo-hanoi-2] Đăng nhập xong. URL: ${page.url()}`);
          console.info(
            `[demo-hanoi-2] Chờ ${pauseMs / 1000}s để bạn theo dõi (có thể tương tác tab)…`,
          );
          await new Promise<void>((r) => setTimeout(r, pauseMs));
        } catch (err) {
          const errPause = Math.max(
            5000,
            parseInt(process.env.DEMO_HANOI_PAUSE_ON_ERROR_MS ?? String(pauseMs), 10) || pauseMs,
          );
          console.error(
            `[demo-hanoi-2] Lỗi — giữ trình duyệt mở thêm ${Math.round(errPause / 1000)}s để bạn xem trạng thái (redirect / thông báo)…`,
          );
          await new Promise<void>((r) => setTimeout(r, errPause));
          keepBrowserOnError = process.env.DEMO_HANOI_KEEP_BROWSER_ON_ERROR === "true";
          if (keepBrowserOnError) {
            console.info(
              "[demo-hanoi-2] DEMO_HANOI_KEEP_BROWSER_ON_ERROR=true — không đóng Chromium; nhấn Ctrl+C khi xong.",
            );
            skipEndBrowserSession = true;
            process.exitCode = 1;
            return;
          }
          throw err;
        }
      } finally {
        if (!keepBrowserOnError) {
          await page.close().catch(() => undefined);
          await ctx.close().catch(() => undefined);
        }
      }
    }
  } finally {
    if (!skipEndBrowserSession) {
      await worker.endBrowserSession();
    }
  }

  console.info("\n[demo-hanoi-2] Hoàn tất 2 tài khoản.");
}

main().catch((err) => {
  console.error("[demo-hanoi-2] Lỗi:", err instanceof Error ? err.message : err);
  process.exit(1);
});
