import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { TaskRepository } from "../../db/taskRepository.js";
import { logger } from "../../core/logger.js";
import type { TaskStatus } from "../../types/task.js";
import { validateKyThangNam } from "../../validation/kyThangNam.js";

const repo = new TaskRepository();
export const tasksRouter = new Hono();

function parseObjectId(id: string): ObjectId | null {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

// ─── POST /tasks — tạo yêu cầu quét mới ─────────────────────────────────────
/**
 * Body: { ky: 1|2|3, thang: 1-12, nam: 2026 }
 *
 * Hệ thống:
 * 1. Validate tham số
 * 2. Kiểm tra task PENDING/RUNNING cùng kỳ — nếu có, trả về task đó (không tạo trùng)
 * 3. Tạo task PENDING → worker sẽ tự động nhận và xử lý
 * 4. Trả về taskId để agent poll status
 */
tasksRouter.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body phải là JSON hợp lệ: { ky, thang, nam }" }, 400);
  }

  const valid = validateKyThangNam(body.ky, body.thang, body.nam);
  if (!valid.ok) return c.json({ error: valid.error, code: valid.code }, 400);

  const { ky, thang, nam } = valid.value;

  // Kiểm tra trùng: đã có task PENDING/RUNNING cho cùng kỳ chưa?
  const existing = await repo.findActiveForPeriod(ky, thang, nam);
  if (existing) {
    return c.json(
      {
        message: `Task cho Kỳ ${ky} Tháng ${thang}/${nam} đang ${existing.status} — không tạo trùng.`,
        taskId: existing._id!.toHexString(),
        status: existing.status,
        createdAt: existing.createdAt,
        isDuplicate: true,
      },
      200,
    );
  }

  // Tạo task mới
  const payload = { period: ky, month: thang, year: nam };
  const taskId = await repo.insertPendingEvn(payload);

  logger.info(`[api/tasks] POST task ${taskId.toHexString()} — Kỳ ${ky} T${thang}/${nam}`);

  return c.json(
    {
      message: `Đã tạo task quét Kỳ ${ky} Tháng ${thang}/${nam}. Worker sẽ xử lý trong vài giây.`,
      taskId: taskId.toHexString(),
      status: "PENDING" as TaskStatus,
      payload,
      isDuplicate: false,
    },
    201,
  );
});

// ─── GET /tasks — danh sách tasks (có filter) ────────────────────────────────
/**
 * Query params: status=PENDING|RUNNING|SUCCESS|FAILED, limit=50, skip=0
 */
tasksRouter.get("/", async (c) => {
  const statusRaw = c.req.query("status");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const skip  = parseInt(c.req.query("skip") ?? "0", 10);

  const validStatuses: TaskStatus[] = ["PENDING", "RUNNING", "SUCCESS", "FAILED"];
  const status = statusRaw
    ? (statusRaw.toUpperCase().split(",").filter((s) => validStatuses.includes(s as TaskStatus)) as TaskStatus[])
    : undefined;

  const [tasks, counts] = await Promise.all([
    repo.findAll({ status: status && status.length > 0 ? status : undefined, limit, skip }),
    repo.countByStatus(),
  ]);

  return c.json({
    total: tasks.length,
    counts,
    data: tasks.map((t) => ({
      taskId: t._id!.toHexString(),
      status: t.status,
      payload: t.payload,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      workerId: t.workerId,
      errorMessage: t.errorMessage,
      resultSummary: t.resultMetadata
        ? {
            downloadedAt: t.resultMetadata.downloadedAt,
            invoiceSync: t.resultMetadata.invoiceSync,
            pdfSync: t.resultMetadata.pdfSync,
            parseSync: t.resultMetadata.parseSync,
          }
        : undefined,
    })),
  });
});

// ─── GET /tasks/active — tasks đang xử lý ────────────────────────────────────
tasksRouter.get("/active", async (c) => {
  const tasks = await repo.findAll({ status: ["PENDING", "RUNNING"] });
  return c.json({ total: tasks.length, data: tasks });
});

// ─── GET /tasks/counts — đếm theo status ─────────────────────────────────────
tasksRouter.get("/counts", async (c) => {
  const counts = await repo.countByStatus();
  return c.json({ counts });
});

// ─── GET /tasks/:taskId — chi tiết 1 task ────────────────────────────────────
tasksRouter.get("/:taskId", async (c) => {
  const oid = parseObjectId(c.req.param("taskId"));
  if (!oid) return c.json({ error: "taskId không hợp lệ" }, 400);

  const task = await repo.findById(oid);
  if (!task) return c.json({ error: "Không tìm thấy task" }, 404);

  return c.json({
    taskId: task._id!.toHexString(),
    status: task.status,
    provider: task.provider,
    payload: task.payload,
    workerId: task.workerId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    errorMessage: task.errorMessage,
    resultMetadata: task.resultMetadata,
  });
});

// ─── POST /tasks/:taskId/cancel — hủy task PENDING ───────────────────────────
tasksRouter.post("/:taskId/cancel", async (c) => {
  const oid = parseObjectId(c.req.param("taskId"));
  if (!oid) return c.json({ error: "taskId không hợp lệ" }, 400);

  const task = await repo.findById(oid);
  if (!task) return c.json({ error: "Không tìm thấy task" }, 404);
  if (task.status !== "PENDING") {
    return c.json(
      { error: `Chỉ hủy được task PENDING. Task này đang ở trạng thái ${task.status}.` },
      409,
    );
  }

  const ok = await repo.cancelPending(oid);
  return c.json({ success: ok, message: ok ? "Đã hủy task." : "Hủy thất bại." });
});

// ─── POST /tasks/:taskId/retry — tạo lại task FAILED ─────────────────────────
tasksRouter.post("/:taskId/retry", async (c) => {
  const oid = parseObjectId(c.req.param("taskId"));
  if (!oid) return c.json({ error: "taskId không hợp lệ" }, 400);

  const newId = await repo.retryFailed(oid);
  if (!newId) {
    const task = await repo.findById(oid);
    if (!task) return c.json({ error: "Không tìm thấy task" }, 404);
    return c.json(
      { error: `Chỉ retry được task FAILED. Task này đang ở trạng thái ${task.status}.` },
      409,
    );
  }

  return c.json(
    {
      message: "Đã tạo task retry mới.",
      newTaskId: newId.toHexString(),
      status: "PENDING",
    },
    201,
  );
});
