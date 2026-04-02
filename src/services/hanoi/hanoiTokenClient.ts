import type { ObjectId } from "mongodb";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { encryptHanoiPassword, decryptHanoiPassword } from "../crypto/hanoiCredentials.js";
import type { HanoiAccountRepository } from "../../db/hanoiAccountRepository.js";
import type { HanoiAccount } from "../../types/hanoiAccount.js";
import { HanoiLoginWrongCredentialsError } from "../../providers/hanoi/hanoiLoginErrors.js";

export interface HanoiPasswordTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

/**
 * Lấy access_token qua OAuth2 password grant — không cần trình duyệt.
 * @see https://apicskh.evnhanoi.vn/connect/token
 */
export async function fetchHanoiPasswordToken(
  username: string,
  passwordPlain: string,
): Promise<HanoiPasswordTokenResponse> {
  const body = new URLSearchParams({
    username: username.trim(),
    password: passwordPlain,
    grant_type: "password",
    client_id: env.hanoiStsClientId,
    client_secret: env.hanoiStsClientSecret,
  });

  const res = await fetch(env.hanoiStsTokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(env.hanoiStsTokenTimeoutMs),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let errCode = "";
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      errCode = (j.error ?? "").toLowerCase();
      if (errCode === "invalid_grant" || /invalid|password|credential|unauthorized/i.test(text)) {
        throw new HanoiLoginWrongCredentialsError(
          `STS từ chối: ${j.error_description ?? j.error ?? text.slice(0, 300)}`,
        );
      }
    } catch (e) {
      if (e instanceof HanoiLoginWrongCredentialsError) throw e;
    }
    throw new Error(
      `HANOI_STS HTTP ${res.status} — ${text.slice(0, 500)}`,
    );
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("HANOI_STS: phản hồi không phải JSON");
  }

  const access_token = typeof json.access_token === "string" ? json.access_token : "";
  const expires_in =
    typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in) || 3600;
  if (!access_token) {
    throw new Error("HANOI_STS: thiếu access_token trong phản hồi");
  }

  return { access_token, expires_in, token_type: typeof json.token_type === "string" ? json.token_type : undefined };
}

/**
 * Trả về access_token hợp lệ: dùng cache DB nếu còn hạn, không thì gọi STS và lưu lại.
 */
export async function getOrRefreshHanoiAccessToken(
  account: HanoiAccount,
  accountId: ObjectId,
  passwordPlain: string,
  repo: HanoiAccountRepository,
  credentialsSecret: string,
): Promise<string> {
  const bufferMs = env.hanoiApiTokenRefreshBufferSec * 1000;
  const now = Date.now();

  if (
    account.apiAccessTokenEncrypted &&
    account.apiTokenExpiresAt &&
    account.apiTokenExpiresAt.getTime() - bufferMs > now
  ) {
    try {
      return decryptHanoiPassword(account.apiAccessTokenEncrypted, credentialsSecret);
    } catch {
      logger.warn(`[hanoi-token] Giải mã token cache lỗi — lấy token mới cho ${account.username}`);
    }
  }

  const { access_token, expires_in } = await fetchHanoiPasswordToken(account.username, passwordPlain);
  const expiresAt = new Date(now + Math.max(60, expires_in) * 1000);
  const encrypted = encryptHanoiPassword(access_token, credentialsSecret);
  await repo.updateApiToken(accountId, encrypted, expiresAt);

  logger.debug(`[hanoi-token] Đã lưu token mới cho ${account.username} — hết hạn ~${expiresAt.toISOString()}`);
  return access_token;
}
