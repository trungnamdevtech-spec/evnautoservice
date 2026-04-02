import type { ObjectId } from "mongodb";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import type { HanoiAccountRepository } from "../../db/hanoiAccountRepository.js";
import type { HanoiAccount } from "../../types/hanoiAccount.js";
import type { HanoiUserInfoSnapshot } from "../../types/hanoiUserInfo.js";

/**
 * GET /connect/userinfo — Bearer token.
 */
export async function fetchHanoiUserInfo(accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(env.hanoiStsUserInfoUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/plain, */*",
      Referer: `${env.evnHanoiBaseUrl.replace(/\/$/, "")}/`,
    },
    signal: AbortSignal.timeout(env.hanoiUserInfoTimeoutMs),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`HANOI userinfo HTTP ${res.status} — ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("HANOI userinfo: phản hồi không phải JSON");
  }
}

export function parseHanoiUserInfo(raw: Record<string, unknown>): HanoiUserInfoSnapshot {
  const stamp = raw["AspNet.Identity.SecurityStamp"];
  const roleRaw = raw.role;
  const roles =
    Array.isArray(roleRaw) ? roleRaw.filter((x): x is string => typeof x === "string") : undefined;

  return {
    sub: typeof raw.sub === "string" ? raw.sub : undefined,
    maDvql: typeof raw.maDvql === "string" ? raw.maDvql : undefined,
    maKhachHang: typeof raw.maKhachHang === "string" ? raw.maKhachHang : undefined,
    keyUser: typeof raw.keyUser === "string" ? raw.keyUser : undefined,
    profile: typeof raw.profile === "string" ? raw.profile : undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
    preferredUsername: typeof raw.preferred_username === "string" ? raw.preferred_username : undefined,
    phoneNumber: typeof raw.phone_number === "string" ? raw.phone_number : undefined,
    lastLogin: typeof raw.lastLogin === "string" ? raw.lastLogin : undefined,
    role: roles,
    securityStamp: typeof stamp === "string" ? stamp : undefined,
  };
}

/**
 * Lấy và lưu userinfo khi cần (theo HANOI_USERINFO_REFRESH_MIN_MS).
 * Trả về snapshot mới nhất (để gắn vào metadata task).
 */
export async function ensureHanoiUserInfo(
  account: HanoiAccount,
  accountId: ObjectId,
  accessToken: string,
  repo: HanoiAccountRepository,
): Promise<HanoiUserInfoSnapshot> {
  const minMs = env.hanoiUserInfoRefreshMinMs;
  const now = Date.now();
  const ui = account.userInfo;
  if (
    minMs > 0 &&
    ui?.maDvql &&
    ui?.maKhachHang &&
    account.userInfoFetchedAt &&
    now - account.userInfoFetchedAt.getTime() < minMs
  ) {
    return ui;
  }

  const raw = await fetchHanoiUserInfo(accessToken);
  const snapshot = parseHanoiUserInfo(raw);
  await repo.updateUserInfo(accountId, snapshot);
  logger.debug(
    `[hanoi-userinfo] Đã lưu userinfo — maDvql=${snapshot.maDvql ?? "?"} maKh=${snapshot.maKhachHang ?? "?"}`,
  );
  return snapshot;
}
