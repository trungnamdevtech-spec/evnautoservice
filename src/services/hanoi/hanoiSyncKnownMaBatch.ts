import pLimit from "p-limit";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import { HanoiAccountRepository } from "../../db/hanoiAccountRepository.js";
import { HanoiContractRepository } from "../../db/hanoiContractRepository.js";
import { decryptHanoiPassword } from "../crypto/hanoiCredentials.js";
import { getOrRefreshHanoiAccessToken } from "./hanoiTokenClient.js";
import { ensureHanoiUserInfo } from "./hanoiUserInfoClient.js";
import { ensureHanoiHopDongSnapshot } from "./hanoiHopDongSync.js";
import type { HanoiAccount } from "../../types/hanoiAccount.js";

export type HanoiSyncKnownMaBatchOptions = {
  allInDb: boolean;
  forceRefresh: boolean;
  concurrency: number;
  delayMs: number;
};

export type HanoiSyncKnownMaBatchResult = {
  totalAccounts: number;
  ok: number;
  skipped: number;
  fail: number;
  errors: Array<{ username: string; error: string }>;
};

export async function loadHanoiAccountsForSync(
  hanoiRepo: HanoiAccountRepository,
  allInDb: boolean,
): Promise<HanoiAccount[]> {
  const out: HanoiAccount[] = [];
  const batch = 500;
  for (let skip = 0; skip < 200_000; skip += batch) {
    const rows = allInDb
      ? await hanoiRepo.listAll(skip, batch)
      : await hanoiRepo.listEnabled(skip, batch);
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < batch) break;
  }
  return out;
}

/**
 * Một tài khoản: STS → userinfo → hợp đồng → `knownMaKhachHang`.
 */
export async function syncOneHanoiAccountKnownMa(
  account: HanoiAccount,
  hanoiRepo: HanoiAccountRepository,
  contractRepo: HanoiContractRepository,
  secret: string,
  forceRefresh: boolean,
): Promise<{ outcome: "ok"; knownCount: number } | { outcome: "skipped"; reason: string }> {
  const accountId = account._id!;
  if (!account.enabled || account.disabledReason === "wrong_password") {
    return { outcome: "skipped", reason: "disabled_or_wrong_password" };
  }

  const password = decryptHanoiPassword(account.passwordEncrypted, secret);
  const accessToken = await getOrRefreshHanoiAccessToken(
    account,
    accountId,
    password,
    hanoiRepo,
    secret,
  );

  await ensureHanoiUserInfo(account, accountId, accessToken, hanoiRepo, { forceRefresh });

  const accAfter = (await hanoiRepo.findById(accountId)) ?? account;
  const hop = await ensureHanoiHopDongSnapshot(
    accAfter,
    accountId,
    accessToken,
    hanoiRepo,
    contractRepo,
    { forceRefresh },
  );

  const fresh = await hanoiRepo.findById(accountId);
  const known = fresh?.knownMaKhachHang ?? [];
  const knownCount = known.length;

  logger.info(
    `[sync-hanoi-known-ma] ${account.username} — userinfo+hopDong ok (hop skipped=${hop.skipped} rows=${hop.rowCount}) knownMaKhachHang=${knownCount}`,
  );

  return { outcome: "ok", knownCount };
}

export async function runHanoiSyncKnownMaBatch(
  opts: HanoiSyncKnownMaBatchOptions,
  repos?: { hanoiRepo: HanoiAccountRepository; contractRepo: HanoiContractRepository },
): Promise<HanoiSyncKnownMaBatchResult> {
  const secret = env.hanoiCredentialsSecret.trim();
  if (!secret) {
    throw new Error("Thiếu HANOI_CREDENTIALS_SECRET");
  }

  const hanoiRepo = repos?.hanoiRepo ?? new HanoiAccountRepository();
  const contractRepo = repos?.contractRepo ?? new HanoiContractRepository();
  const accounts = await loadHanoiAccountsForSync(hanoiRepo, opts.allInDb);

  let ok = 0;
  let skipped = 0;
  let fail = 0;
  const errors: Array<{ username: string; error: string }> = [];

  const limit = pLimit(opts.concurrency);

  await Promise.all(
    accounts.map((account) =>
      limit(async () => {
        const username = account.username;
        try {
          const r = await syncOneHanoiAccountKnownMa(
            account,
            hanoiRepo,
            contractRepo,
            secret,
            opts.forceRefresh,
          );
          if (r.outcome === "ok") {
            ok++;
          } else {
            skipped++;
          }
        } catch (e) {
          fail++;
          const msg = e instanceof Error ? e.message : String(e);
          errors.push({ username, error: msg });
          logger.warn(`[sync-hanoi-known-ma] ${username} — ${msg}`);
        }
        if (opts.delayMs > 0) {
          await new Promise((res) => setTimeout(res, opts.delayMs));
        }
      }),
    ),
  );

  return {
    totalAccounts: accounts.length,
    ok,
    skipped,
    fail,
    errors,
  };
}
