import pLimit from "p-limit";
import { env } from "../config/env.js";
import { logger } from "../core/logger.js";
import type { TaskRepository } from "../db/taskRepository.js";
import { AnticaptchaClient } from "../services/captcha/AnticaptchaClient.js";
import { EVNCPCWorker } from "../providers/evn/EVNCPCWorker.js";
import { EVNNPCWorker } from "../providers/npc/EVNNPCWorker.js";
import { claimAndProcessNext, createWorkerId } from "./processTask.js";

/**
 * Vòng lặp worker: giới hạn N task song song (N context/page trên một Chromium process khi có việc).
 * EVN CPC / NPC: Chromium chỉ launch khi có task PENDING được claim; sau khi mọi task đang chạy xong
 * thì browser được đóng (xem BaseWorker.beginBrowserSession / endBrowserSession).
 * Mỗi job trong pool xử lý một task đã claim; không để treo logic: mọi lỗi đều ghi FAILED.
 */
export class TaskRunner {
  private readonly workerId = createWorkerId();
  private readonly captcha = new AnticaptchaClient();
  private readonly evnWorker = new EVNCPCWorker(this.captcha);
  private readonly npcWorker = new EVNNPCWorker(this.captcha);
  private stopped = false;

  constructor(private readonly repo: TaskRepository) {}

  async startLoop(): Promise<void> {
    const limit = pLimit(env.workerConcurrency);

    while (!this.stopped) {
      const results = await Promise.all(
        Array.from({ length: env.workerConcurrency }, () =>
          limit(async (): Promise<boolean> => {
            try {
              return await claimAndProcessNext(this.repo, this.evnWorker, this.npcWorker, this.workerId);
            } catch (err) {
              logger.error("[TaskRunner] claim/process lỗi không mong đợi:", err);
              return false;
            }
          }),
        ),
      );

      const didWork = results.some(Boolean);
      if (!didWork) {
        logger.debug(`[TaskRunner] Không có task PENDING — chờ ${env.taskPollIntervalMs}ms`);
      }

      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, env.taskPollIntervalMs));
    }

    await this.evnWorker.disposeBrowser();
  }

  stop(): void {
    this.stopped = true;
  }
}
