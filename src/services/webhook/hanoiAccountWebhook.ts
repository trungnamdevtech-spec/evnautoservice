import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";

/** Payload POST tới `HANOI_ACCOUNT_WEBHOOK_URL` sau đổi MK / kiểm tra STS. */
export type HanoiAccountWebhookPayload = {
  event: "hanoi.account.credential_update";
  hanoiAccountId: string;
  username: string;
  correlationId: string | null;
  passwordUpdated: boolean;
  stsVerify: {
    attempted: boolean;
    success: boolean | null;
    errorMessage: string | null;
    markedWrongPassword: boolean;
  };
  occurredAt: string;
};

export async function fireHanoiAccountWebhook(payload: HanoiAccountWebhookPayload): Promise<void> {
  const url = env.hanoiAccountWebhookUrl;
  if (!url) return;

  const bodyStr = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "EVN-AutoCheck-HanoiAccount/1",
  };
  const secret = env.hanoiAccountWebhookSecret;
  if (secret) {
    const sig = createHmac("sha256", secret).update(bodyStr).digest("hex");
    headers["X-Hanoi-Account-Signature"] = `sha256=${sig}`;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), env.hanoiAccountWebhookTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(
        `[hanoi-account-webhook] ${payload.hanoiAccountId} — POST ${url} → HTTP ${res.status}`,
      );
    } else {
      logger.info(`[hanoi-account-webhook] ${payload.hanoiAccountId} — delivered HTTP ${res.status}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[hanoi-account-webhook] ${payload.hanoiAccountId} — ${msg}`);
  } finally {
    clearTimeout(t);
  }
}
