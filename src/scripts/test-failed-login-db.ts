/**
 * Minh họa: đăng nhập sai → ném lỗi → processTask ghi MongoDB status FAILED + errorMessage.
 * Cần MongoDB chạy (MONGODB_URI trong .env).
 * Usage: npm run test:login:db
 */
import "dotenv/config";

async function main(): Promise<void> {
  process.env.EVN_CPC_LOGIN_PASSWORD = "__WRONG_PASSWORD_FOR_DB_TEST__";

  const { getMongoDb, closeMongo } = await import("../db/mongo.js");
  const { TaskRepository } = await import("../db/taskRepository.js");
  const { processTask } = await import("../worker/processTask.js");
  const { AnticaptchaClient } = await import("../services/captcha/AnticaptchaClient.js");
  const { EVNCPCWorker } = await import("../providers/evn/EVNCPCWorker.js");

  await getMongoDb();
  const repo = new TaskRepository();
  const worker = new EVNCPCWorker(new AnticaptchaClient());

  const id = await repo.insertPendingEvn({ customerCode: "demo-db-test" });
  const task = await repo.findById(id);
  if (!task) {
    throw new Error("Không tạo được task");
  }

  console.info("[test-failed-login-db] Task _id:", id.toHexString());
  await processTask(task, repo, worker);

  const after = await repo.findById(id);
  console.info("[test-failed-login-db] status:", after?.status);
  console.info("[test-failed-login-db] errorMessage (rút gọn 600 ký tự):");
  console.info(after?.errorMessage?.slice(0, 600) ?? "(trống)");

  await closeMongo();
}

main().catch((err) => {
  console.error("[test-failed-login-db]", err);
  process.exit(1);
});
