import { createHmac } from "node:crypto";
import type { ObjectId } from "mongodb";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import type { InvoiceDownloadMetadata } from "../../types/task.js";
import type { ScrapeTask } from "../../types/task.js";

/** Payload POST tới `AGENT_TASK_WEBHOOK_URL` khi task kết thúc. */
export type AgentTaskWebhookPayload = {
  event: "task.finished";
  taskId: string;
  provider: ScrapeTask["provider"];
  status: "SUCCESS" | "FAILED";
  payload: Record<string, unknown>;
  resultMetadata: InvoiceDownloadMetadata | null;
  errorMessage: string | null;
  completedAt: string;
};

/** Cùng URL/secret với task — Agent biết kết quả ensure-bill khi cache hoặc đã có task (không cần đợi worker). */
export type HanoiEnsureBillWebhookPayload = {
  event: "hanoi.ensure_bill";
  outcome: "cache_hit" | "already_queued";
  provider: "EVN_HANOI";
  maKhachHang: string;
  hanoiAccountId: string | null;
  period: { ky: number; thang: number; nam: number };
  dataSource: "database" | "task_queue";
  taskId: string | null;
  billInvoiceId: number | null;
  completedAt: string;
};

/**
 * Gửi kết quả task tới Agent Gateway (không throw — lỗi chỉ log).
 * Bật khi đặt `AGENT_TASK_WEBHOOK_URL`.
 */
export async function fireAgentTaskWebhook(args: {
  task: ScrapeTask;
  taskId: ObjectId;
  status: "SUCCESS" | "FAILED";
  resultMetadata?: InvoiceDownloadMetadata | null;
  errorMessage?: string | null;
}): Promise<void> {
  const url = env.agentTaskWebhookUrl;
  if (!url) return;

  const bodyObj: AgentTaskWebhookPayload = {
    event: "task.finished",
    taskId: args.taskId.toHexString(),
    provider: args.task.provider,
    status: args.status,
    payload: args.task.payload as Record<string, unknown>,
    resultMetadata: args.status === "SUCCESS" ? (args.resultMetadata ?? null) : null,
    errorMessage: args.status === "FAILED" ? (args.errorMessage ?? null) : null,
    completedAt: new Date().toISOString(),
  };

  const bodyStr = JSON.stringify(bodyObj);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "EVN-AutoCheck-Worker/1",
  };
  const secret = env.agentTaskWebhookSecret;
  if (secret) {
    const sig = createHmac("sha256", secret).update(bodyStr).digest("hex");
    headers["X-Agent-Task-Signature"] = `sha256=${sig}`;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), env.agentTaskWebhookTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(
        `[webhook] task ${bodyObj.taskId} — POST ${url} → HTTP ${res.status} ${res.statusText}`,
      );
    } else {
      logger.info(`[webhook] task ${bodyObj.taskId} — delivered HTTP ${res.status}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[webhook] task ${bodyObj.taskId} — ${msg}`);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Webhook ensure-bill Hanoi (cache DB hoặc đã có task) — không throw.
 * Bật khi đặt `AGENT_TASK_WEBHOOK_URL` (cùng endpoint với `task.finished`).
 */
export async function fireHanoiEnsureBillWebhook(args: {
  outcome: "cache_hit" | "already_queued";
  maKhachHang: string;
  hanoiAccountId: string | null;
  period: { ky: number; thang: number; nam: number };
  taskId: string | null;
  billInvoiceId: number | null;
  dataSource: "database" | "task_queue";
}): Promise<void> {
  const url = env.agentTaskWebhookUrl;
  if (!url) return;

  const bodyObj: HanoiEnsureBillWebhookPayload = {
    event: "hanoi.ensure_bill",
    outcome: args.outcome,
    provider: "EVN_HANOI",
    maKhachHang: args.maKhachHang,
    hanoiAccountId: args.hanoiAccountId,
    period: args.period,
    dataSource: args.dataSource,
    taskId: args.taskId,
    billInvoiceId: args.billInvoiceId,
    completedAt: new Date().toISOString(),
  };

  const bodyStr = JSON.stringify(bodyObj);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "EVN-AutoCheck-Worker/1",
  };
  const secret = env.agentTaskWebhookSecret;
  if (secret) {
    const sig = createHmac("sha256", secret).update(bodyStr).digest("hex");
    headers["X-Agent-Task-Signature"] = `sha256=${sig}`;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), env.agentTaskWebhookTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(
        `[webhook] hanoi.ensure_bill ${args.outcome} — POST ${url} → HTTP ${res.status} ${res.statusText}`,
      );
    } else {
      logger.info(`[webhook] hanoi.ensure_bill ${args.outcome} — delivered HTTP ${res.status}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[webhook] hanoi.ensure_bill ${args.outcome} — ${msg}`);
  } finally {
    clearTimeout(t);
  }
}
