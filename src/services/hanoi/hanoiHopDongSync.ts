import type { ObjectId } from "mongodb";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger.js";
import type { HanoiAccountRepository } from "../../db/hanoiAccountRepository.js";
import type { HanoiContractRepository } from "../../db/hanoiContractRepository.js";
import type { HanoiAccount } from "../../types/hanoiAccount.js";
import { fetchHanoiDanhSachHopDong } from "./hanoiGetDanhSachHopDongClient.js";

/**
 * Đồng bộ danh sách hợp đồng / KH vào `hanoi_contracts` sau khi có Bearer.
 * Tôn trọng HANOI_HOP_DONG_REFRESH_MIN_MS (0 = luôn gọi API).
 */
export async function ensureHanoiHopDongSnapshot(
  account: HanoiAccount,
  accountId: ObjectId,
  accessToken: string,
  hanoiRepo: HanoiAccountRepository,
  contractRepo: HanoiContractRepository,
): Promise<{ rowCount: number; skipped: boolean; skippedNoMa: number }> {
  const minMs = env.hanoiHopDongRefreshMinMs;
  const now = Date.now();
  if (
    minMs > 0 &&
    account.hopDongFetchedAt &&
    now - account.hopDongFetchedAt.getTime() < minMs
  ) {
    return { rowCount: 0, skipped: true, skippedNoMa: 0 };
  }

  const { rows } = await fetchHanoiDanhSachHopDong(accessToken);
  const fetchedAt = new Date();
  const { inserted, skippedNoMa } = await contractRepo.replaceAllForAccount(
    accountId,
    account.username,
    rows,
    fetchedAt,
  );
  await hanoiRepo.setHopDongFetchedAt(accountId, fetchedAt);

  logger.debug(
    `[hanoi-hop-dong] Đã lưu ${inserted} hợp đồng — account=${account.username} API_rows=${rows.length} skippedNoMa=${skippedNoMa}`,
  );

  return { rowCount: inserted, skipped: false, skippedNoMa };
}
