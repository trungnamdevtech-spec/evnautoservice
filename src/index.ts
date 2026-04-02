import "./polyfills/installPdfjsDomPolyfills.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { env } from "./config/env.js";
import { logger } from "./core/logger.js";
import { getMongoDb, closeMongo } from "./db/mongo.js";
import { NpcAccountRepository } from "./db/npcAccountRepository.js";
import { TaskRepository } from "./db/taskRepository.js";
import { importNpcAccountsFromXlsxFile } from "./services/npc/npcAccountsXlsxImport.js";
import { TaskRunner } from "./worker/TaskRunner.js";
import { startApiServer } from "./api/server.js";

async function maybeImportNpcAccountsFromXlsxOnStartup(): Promise<void> {
  if (!env.autoImportNpcXlsxOnStart) return;
  const abs = path.resolve(process.cwd(), env.npcAccountsXlsxPath);
  if (!existsSync(abs)) {
    logger.info(`[startup] AUTO_IMPORT_NPC_XLSX: không thấy file ${abs} — bỏ qua.`);
    return;
  }
  if (!env.npcCredentialsSecret.trim()) {
    logger.warn("[startup] AUTO_IMPORT_NPC_XLSX bật nhưng NPC_CREDENTIALS_SECRET trống — bỏ qua import XLSX.");
    return;
  }
  try {
    const repo = new NpcAccountRepository();
    const r = await importNpcAccountsFromXlsxFile(repo, abs);
    if (r.parse.rows.length === 0) {
      logger.warn(`[startup] File XLSX không có dòng dữ liệu hợp lệ (đã đọc ${r.parse.lastRowNumber} dòng): ${abs}`);
    } else {
      logger.info(
        `[startup] Import NPC từ XLSX "${r.parse.sheetName}": inserted=${r.inserted} skipped=${r.skipped} rows=${r.parse.rows.length}`,
      );
    }

    if (r.errors.length > 0) {
      logger.warn(`[startup] Import XLSX — lỗi phụ (tối đa 10): ${r.errors.slice(0, 10).join("; ")}`);
    }
  } catch (err) {
    logger.error("[startup] Import NPC từ XLSX thất bại:", err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  await getMongoDb();
  await maybeImportNpcAccountsFromXlsxOnStartup();

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
      `Scraper chạy khi có task PENDING (EVN_CPC hoặc EVN_NPC).`,
  );
  await runner.startLoop();
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
