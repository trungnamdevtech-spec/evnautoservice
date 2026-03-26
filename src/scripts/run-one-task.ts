/**
 * Chạy thử trọn một task (claim + processTask) rồi thoát — không vòng lặp poll.
 * Cần ít nhất một task PENDING (dùng npm run seed:task).
 */
import "dotenv/config";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { TaskRepository } from "../db/taskRepository.js";
import { AnticaptchaClient } from "../services/captcha/AnticaptchaClient.js";
import { EVNCPCWorker } from "../providers/evn/EVNCPCWorker.js";
import { claimAndProcessNext, createWorkerId } from "../worker/processTask.js";

async function main(): Promise<void> {
  await getMongoDb();
  const repo = new TaskRepository();
  const worker = new EVNCPCWorker(new AnticaptchaClient());
  const wid = createWorkerId();

  console.info("[test:e2e] Đang claim và xử lý một task...");
  const ok = await claimAndProcessNext(repo, worker, wid);

  await closeMongo();
  // Browser đã được processTask đóng qua endBrowserSession khi task xong.

  if (!ok) {
    console.warn("[test:e2e] Không có task PENDING. Chạy: npm run seed:task");
    process.exit(1);
  }
  console.info("[test:e2e] Hoàn thành một task (xem MongoDB: status SUCCESS/FAILED).");
}

main().catch((err) => {
  console.error("[test:e2e]", err);
  process.exit(1);
});
