import type { Page } from "playwright";
import type { ObjectId } from "mongodb";
import { normalizeStorageState } from "../../core/BaseWorker.js";
import type { EVNNPCWorker } from "../../providers/npc/EVNNPCWorker.js";
import type { NpcAccount } from "../../types/npcAccount.js";
import { env } from "../../config/env.js";
import { fetchNpcOnlinePaymentLink, type NpcOnlinePaymentLinkResult } from "./npcOnlinePaymentLink.js";
import { NpcAccountRepository } from "../../db/npcAccountRepository.js";

/**
 * Mở một tab Playwright (context + session đã lưu), đăng nhập IndexNPC nếu cần, rồi lấy link thanh toán trực tuyến.
 * Dùng cho API agent — không dùng chung page với task quét khác.
 */
export async function runNpcOnlinePaymentLinkWithPlaywright(
  worker: EVNNPCWorker,
  account: NpcAccount,
  accountId: ObjectId,
  passwordPlain: string,
  maKhachHang: string,
  traceId: string,
): Promise<NpcOnlinePaymentLinkResult> {
  const step = env.npcStepTimeoutMs;
  const npcRepo = new NpcAccountRepository();
  await worker.beginBrowserSession();
  const ctx = await worker.createDisposableContext(normalizeStorageState(account.storageStateJson ?? undefined));
  let page: Page | null = null;
  try {
    page = await ctx.newPage();
    await worker.prepareNpcIndexNpcSession(page, account, accountId, passwordPlain, traceId, step);
    const raw = maKhachHang.replace(/\u00A0/g, " ").replace(/[\u2000-\u200B\uFEFF]/g, "").trim();
    const resolved = raw !== "" ? maKhachHang : account.username;
    const result = await fetchNpcOnlinePaymentLink(page, resolved, step);
    const storage = await page.context().storageState();
    await npcRepo.updateSession(accountId, JSON.stringify(storage), new Date());
    return result;
  } finally {
    if (page) await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    await worker.endBrowserSession();
  }
}
