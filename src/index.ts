import { env } from "./config/env.js";
import { logger } from "./core/logger.js";
import { getMongoDb, closeMongo } from "./db/mongo.js";
import { TaskRepository } from "./db/taskRepository.js";
import { TaskRunner } from "./worker/TaskRunner.js";
import { startApiServer } from "./api/server.js";

async function main(): Promise<void> {
  await getMongoDb();

  // Khởi động HTTP API server (non-blocking)
  startApiServer();

  const repo = new TaskRepository();
  const runner = new TaskRunner(repo);

  const shutdown = async (signal: string) => {
    logger.info(`Nhận ${signal}, đang dừng worker...`);
    runner.stop();
    await closeMongo();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info(
    `EVN Worker + API — MongoDB db="${env.mongodbDb}", LOG_LEVEL=${env.logLevel}. ` +
      `Scraper chỉ chạy khi có task PENDING (EVN_CPC).`,
  );
  await runner.startLoop();
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
