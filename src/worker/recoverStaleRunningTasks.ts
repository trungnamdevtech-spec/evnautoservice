import { logger } from "../core/logger.js";
import { env } from "../config/env.js";
import type { TaskRepository } from "../db/taskRepository.js";
import { fireAgentTaskWebhook } from "../services/webhook/agentTaskWebhook.js";

const STALE_REASON =
  "Worker dừng đột ngột hoặc tiến trình bị cắt trước khi hoàn tất (task RUNNING được ghi FAILED khi khởi động lại — có thể gọi lại API / retry).";

/**
 * Sau crash / SIGKILL / deploy: các task còn RUNNING trong Mongo sẽ kẹt vĩnh viễn và chặn dedupe `already_queued`.
 * Đánh dấu FAILED + webhook (nếu bật) để agent poll thấy kết thúc rõ ràng.
 */
export async function recoverStaleRunningTasks(repo: TaskRepository): Promise<number> {
  if (!env.taskFailRunningOnStartup) {
    logger.info("[startup] TASK_FAIL_RUNNING_ON_STARTUP=false — bỏ qua dọn task RUNNING cũ.");
    return 0;
  }

  const stuck = await repo.findAllRunning();
  if (stuck.length === 0) return 0;

  logger.warn(
    `[startup] Phát hiện ${stuck.length} task RUNNING sót — đánh dấu FAILED (TASK_FAIL_RUNNING_ON_STARTUP=true).`,
  );

  for (const task of stuck) {
    const taskId = task._id;
    if (!taskId) continue;
    try {
      await repo.markFailed(taskId, STALE_REASON);
      await fireAgentTaskWebhook({
        task,
        taskId,
        status: "FAILED",
        errorMessage: STALE_REASON,
      });
    } catch (err) {
      logger.error(`[startup] Không recover task ${taskId.toHexString()}:`, err);
    }
  }

  return stuck.length;
}
