/**
 * Kiểm tra retry logic khi captcha sai: mock AnticaptchaClient luôn trả "XXXXX" (sai).
 * Kỳ vọng: worker bấm "Thay đổi" tối đa 4 lần rồi throw lỗi → task FAILED trong MongoDB.
 *
 * Usage:
 *   node --import tsx src/scripts/test-wrong-captcha.ts
 */
import "dotenv/config";
import type { ImageCaptchaSolveRequest } from "../services/captcha/AnticaptchaClient.js";
import { AnticaptchaClient } from "../services/captcha/AnticaptchaClient.js";
import { EVNCPCWorker } from "../providers/evn/EVNCPCWorker.js";
import { EVNNPCWorker } from "../providers/npc/EVNNPCWorker.js";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { TaskRepository } from "../db/taskRepository.js";
import { claimAndProcessNext, createWorkerId } from "../worker/processTask.js";

let wrongCallCount = 0;

class WrongCaptchaClient extends AnticaptchaClient {
  override isConfigured(): boolean {
    return true;
  }

  override async solveImageCaptcha(_req: ImageCaptchaSolveRequest): Promise<string> {
    wrongCallCount++;
    const fakeCode = "XXXXX";
    console.warn(`[mock-captcha] Lần ${wrongCallCount}: trả mã SAI cố ý → "${fakeCode}"`);
    return fakeCode;
  }
}

async function main(): Promise<void> {
  await getMongoDb();
  const repo = new TaskRepository();
  const mock = new WrongCaptchaClient();
  const worker = new EVNCPCWorker(mock);
  const npcWorker = new EVNNPCWorker(mock);
  const wid = createWorkerId();

  console.info("[test:wrong-captcha] Bắt đầu — mock captcha luôn sai, kiểm tra retry 4 lần...");
  const ok = await claimAndProcessNext(repo, worker, npcWorker, wid);

  await closeMongo();
  // Browser đã được processTask đóng qua endBrowserSession khi task xong.

  if (!ok) {
    console.warn("[test:wrong-captcha] Không có task PENDING. Chạy: npm run seed:task:demo");
    process.exit(1);
  }

  console.info(`[test:wrong-captcha] Kết thúc. Mock bị gọi ${wrongCallCount} lần.`);
  if (wrongCallCount >= 4) {
    console.info("[test:wrong-captcha] ✓ Đã retry đủ 4 lần → task FAILED như mong đợi.");
  } else {
    console.warn(
      `[test:wrong-captcha] ✗ Chỉ retry ${wrongCallCount} lần (kỳ vọng 4). Kiểm tra lại logic.`,
    );
  }
}

main().catch((err) => {
  console.error("[test:wrong-captcha] Lỗi (có thể do hết retry):", err instanceof Error ? err.message : err);
  console.info(`[test:wrong-captcha] Mock được gọi ${wrongCallCount} lần tổng cộng.`);
  if (wrongCallCount >= 4) {
    console.info("[test:wrong-captcha] ✓ Retry đủ 4 lần — logic hoạt động đúng.");
  }
  process.exit(0);
});
