import type { HanoiAccount } from "../../types/hanoiAccount.js";
import type { HanoiAccountRepository } from "../../db/hanoiAccountRepository.js";
import type { HanoiContractRepository } from "../../db/hanoiContractRepository.js";

export function normalizeHanoiMaKhachHang(raw: string): string {
  return raw.trim().toUpperCase();
}

function dedupeById(accounts: HanoiAccount[]): HanoiAccount[] {
  const seen = new Set<string>();
  const out: HanoiAccount[] = [];
  for (const a of accounts) {
    const id = a._id?.toHexString();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(a);
  }
  return out;
}

/**
 * Tất cả tài khoản Hanoi có quyền trên mã khách hàng này (đăng nhập để tra cứu).
 * Thứ tự: `knownMaKhachHang` → `hanoi_contracts` → `userInfo.maKhachHang`.
 */
export async function resolveHanoiAccountsByMaKhachHang(
  maKhachHangRaw: string,
  hanoiRepo: HanoiAccountRepository,
  contractRepo: HanoiContractRepository,
): Promise<HanoiAccount[]> {
  const ma = normalizeHanoiMaKhachHang(maKhachHangRaw);
  if (!ma) return [];

  const byIndex = await hanoiRepo.findByKnownMaKhachHang(ma);
  if (byIndex.length > 0) return dedupeById(byIndex);

  const contracts = await contractRepo.findByMaKhachHang(ma);
  const out: HanoiAccount[] = [];
  const seen = new Set<string>();
  for (const row of contracts) {
    const id = row.hanoiAccountId;
    const hex = id.toHexString();
    if (seen.has(hex)) continue;
    seen.add(hex);
    const acc = await hanoiRepo.findById(id);
    if (acc?.enabled && acc.disabledReason !== "wrong_password") out.push(acc);
  }
  if (out.length > 0) return dedupeById(out);

  return dedupeById(await hanoiRepo.findByUserInfoMaKhachHang(ma));
}

export type ResolveOneHanoiByMaResult =
  | { ok: true; account: HanoiAccount }
  | {
      ok: false;
      code: "NOT_FOUND" | "AMBIGUOUS";
      message: string;
      candidates?: Array<{ hanoiAccountId: string; username: string }>;
    };

export async function resolveSingleHanoiAccountByMaKhachHang(
  maKhachHangRaw: string,
  hanoiRepo: HanoiAccountRepository,
  contractRepo: HanoiContractRepository,
): Promise<ResolveOneHanoiByMaResult> {
  const list = await resolveHanoiAccountsByMaKhachHang(maKhachHangRaw, hanoiRepo, contractRepo);
  if (list.length === 0) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message:
        "Không có tài khoản Hanoi nào gắn với mã khách hàng này — cần đồng bộ hợp đồng/userinfo (worker hoặc đăng nhập API) hoặc kiểm tra mã.",
    };
  }
  if (list.length > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS",
      message: `Có ${list.length} tài khoản cùng quản lý mã khách hàng này — truyền hanoiAccountId cụ thể.`,
      candidates: list.map((a) => ({
        hanoiAccountId: a._id!.toHexString(),
        username: a.username,
      })),
    };
  }
  return { ok: true, account: list[0]! };
}

/** Mã KH dùng lọc `electricity_bills` sau khi đã có account (ưu tiên mã agent nhập). */
export function effectiveMaKhachHangForBills(
  agentMaKhachHang: string | undefined,
  account: HanoiAccount,
): string {
  const fromAgent = agentMaKhachHang?.trim();
  if (fromAgent) return normalizeHanoiMaKhachHang(fromAgent);
  const ui = account.userInfo?.maKhachHang?.trim();
  if (ui) return normalizeHanoiMaKhachHang(ui);
  return account.username.trim().toUpperCase();
}
