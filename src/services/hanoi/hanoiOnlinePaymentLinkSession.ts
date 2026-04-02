import type { Page } from "playwright";
import type { ObjectId } from "mongodb";
import { normalizeStorageState } from "../../core/BaseWorker.js";
import type { EVNHanoiWorker } from "../../providers/hanoi/EVNHanoiWorker.js";
import type { HanoiAccount } from "../../types/hanoiAccount.js";
import { env } from "../../config/env.js";
import {
  fetchHanoiOnlinePaymentLink,
  type HanoiOnlinePaymentLinkResult,
} from "./hanoiOnlinePaymentLink.js";
import { HanoiAccountRepository } from "../../db/hanoiAccountRepository.js";
import { getOrRefreshHanoiAccessToken } from "./hanoiTokenClient.js";
import { ensureHanoiUserInfo } from "./hanoiUserInfoClient.js";
import { logTaskPhase } from "../../core/logger.js";

/**
 * Lấy link thanh toán bằng Bearer token (STS) — không mở Chromium.
 */
export async function runHanoiOnlinePaymentLinkWithApi(
  account: HanoiAccount,
  accountId: ObjectId,
  passwordPlain: string,
  maKhachHang: string,
  traceId: string,
): Promise<HanoiOnlinePaymentLinkResult> {
  const secret = env.hanoiCredentialsSecret.trim();
  if (!secret) {
    throw new Error("Thiếu HANOI_CREDENTIALS_SECRET");
  }
  const hanoiRepo = new HanoiAccountRepository();
  const step = env.hanoiStepTimeoutMs;
  const ma = maKhachHang.trim().toUpperCase() || account.username.trim().toUpperCase();
  logTaskPhase(traceId, "HANOI_ONLINE_PAYMENT", `Tra cứu link thanh toán (API) ma=${ma}`);
  const token = await getOrRefreshHanoiAccessToken(account, accountId, passwordPlain, hanoiRepo, secret);
  const userInfo = await ensureHanoiUserInfo(account, accountId, token, hanoiRepo);
  return fetchHanoiOnlinePaymentLink(ma, step, {
    accessToken: token,
    maDViQLy: userInfo.maDvql,
  });
}

/**
 * Mở một tab Playwright (context + session đã lưu), đăng nhập Hanoi nếu cần,
 * rồi lấy link thanh toán trực tuyến — chỉ dùng khi HANOI_USE_API_LOGIN=false.
 */
export async function runHanoiOnlinePaymentLinkWithPlaywright(
  worker: EVNHanoiWorker,
  account: HanoiAccount,
  accountId: ObjectId,
  passwordPlain: string,
  maKhachHang: string,
  traceId: string,
): Promise<HanoiOnlinePaymentLinkResult> {
  const step = env.hanoiStepTimeoutMs;
  const secret = env.hanoiCredentialsSecret.trim();
  if (!secret) {
    throw new Error("Thiếu HANOI_CREDENTIALS_SECRET");
  }
  const hanoiRepo = new HanoiAccountRepository();
  await worker.beginBrowserSession();
  const ctx = await worker.createDisposableContext(
    normalizeStorageState(account.storageStateJson ?? undefined),
  );
  let page: Page | null = null;
  try {
    page = await ctx.newPage();
    await worker.prepareHanoiSession(page, account, accountId, passwordPlain, traceId, step);
    const ma = maKhachHang.trim().toUpperCase() || account.username.trim().toUpperCase();
    logTaskPhase(traceId, "HANOI_ONLINE_PAYMENT", `Tra cứu link thanh toán (STS sau Playwright) ma=${ma}`);
    const token = await getOrRefreshHanoiAccessToken(account, accountId, passwordPlain, hanoiRepo, secret);
    const userInfo = await ensureHanoiUserInfo(account, accountId, token, hanoiRepo);
    const result = await fetchHanoiOnlinePaymentLink(ma, step, {
      accessToken: token,
      maDViQLy: userInfo.maDvql,
      page,
    });
    const storage = await page.context().storageState();
    await hanoiRepo.updateSession(accountId, JSON.stringify(storage), new Date());
    return result;
  } finally {
    if (page) await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    await worker.endBrowserSession();
  }
}
