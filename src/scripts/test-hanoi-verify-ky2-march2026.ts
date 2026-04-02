/**
 * Kiểm tra luồng: tra cứu → tìm đúng kỳ/tháng/năm → GET XemHoaDon — **một PDF** (TB+GTGT) → đối chiếu `electricity_bills`.
 *
 * Dùng tài khoản Hanoi **enabled** đầu tiên trong MongoDB (giống test-hanoi-api-flow).
 *
 * Usage:
 *   npm run test:hanoi-verify-ky2
 *   HANOI_VERIFY_MA_KH=HN04...     — chỉ thử các cặp có maKh khớp
 *   HANOI_VERIFY_THANG=3          — mặc định 3
 *   HANOI_VERIFY_NAM=2026         — mặc định 2026
 *   HANOI_VERIFY_KY=2             — mặc định 2
 *
 * Yêu cầu: MONGODB_URI, MONGODB_DB, HANOI_CREDENTIALS_SECRET, biến base EVN Hà Nội trong .env
 */
import "dotenv/config";
import { env } from "../config/env.js";
import { HanoiAccountRepository } from "../db/hanoiAccountRepository.js";
import { HanoiContractRepository } from "../db/hanoiContractRepository.js";
import { ElectricityBillRepository } from "../db/electricityBillRepository.js";
import { decryptHanoiPassword } from "../services/crypto/hanoiCredentials.js";
import { getOrRefreshHanoiAccessToken } from "../services/hanoi/hanoiTokenClient.js";
import { ensureHanoiUserInfo } from "../services/hanoi/hanoiUserInfoClient.js";
import { hanoiHumanPause } from "../services/hanoi/hanoiBrowserLikeHeaders.js";
import {
  dedupeHanoiDmThongTinByIdHdon,
  fetchHanoiGetThongTinHoaDon,
  filterHanoiThongTinRowsForMonth,
} from "../services/hanoi/hanoiGetThongTinHoaDonClient.js";
import { fetchHanoiXemHoaDonPdf } from "../services/hanoi/hanoiXemHoaDonPdfClient.js";
import { hanoiBillKey } from "../services/hanoi/hanoiElectricityBillId.js";
import type { HanoiDmThongTinHoaDonItem } from "../types/hanoiGetThongTinHoaDon.js";
import type { HanoiContract } from "../types/hanoiHopDong.js";
import type { HanoiUserInfoSnapshot } from "../types/hanoiUserInfo.js";

function parseIntEnv(name: string, fallback: number): number {
  const v = (process.env[name] ?? "").trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const THANG = Math.max(1, Math.min(12, parseIntEnv("HANOI_VERIFY_THANG", 3)));
const NAM = parseIntEnv("HANOI_VERIFY_NAM", 2026);
const KY_TARGET = Math.max(1, Math.min(3, parseIntEnv("HANOI_VERIFY_KY", 2))) as 1 | 2 | 3;

function buildPairs(
  contracts: HanoiContract[],
  userInfo: HanoiUserInfoSnapshot | undefined,
): Array<{ maDvql: string; maKh: string }> {
  const map = new Map<string, { maDvql: string; maKh: string }>();
  for (const c of contracts) {
    const dv = (c.normalized.maDvql ?? String(c.raw["maDonViQuanLy"] ?? "")).trim();
    const kh = c.maKhachHang?.trim().toUpperCase();
    if (!dv || !kh) continue;
    map.set(`${dv}|${kh}`, { maDvql: dv, maKh: kh });
  }
  if (map.size === 0 && userInfo?.maDvql?.trim() && userInfo.maKhachHang?.trim()) {
    const dv = userInfo.maDvql.trim();
    const kh = userInfo.maKhachHang.trim().toUpperCase();
    map.set(`${dv}|${kh}`, { maDvql: dv, maKh: kh });
  }
  return [...map.values()].sort(
    (a, b) => a.maDvql.localeCompare(b.maDvql, "vi") || a.maKh.localeCompare(b.maKh, "vi"),
  );
}

async function mergeTraCuuForMonth(
  token: string,
  pair: { maDvql: string; maKh: string },
): Promise<HanoiDmThongTinHoaDonItem[]> {
  const merged: HanoiDmThongTinHoaDonItem[] = [];
  for (const kyUrl of [1, 2, 3] as const) {
    if (kyUrl > 1) await hanoiHumanPause(env);
    const tra = await fetchHanoiGetThongTinHoaDon(token, {
      maDvql: pair.maDvql,
      maKh: pair.maKh,
      thang: THANG,
      nam: NAM,
      ky: kyUrl,
    });
    merged.push(...(tra.data?.dmThongTinHoaDonList ?? []));
  }
  return dedupeHanoiDmThongTinByIdHdon(
    filterHanoiThongTinRowsForMonth(merged, { thang: THANG, nam: NAM }),
  );
}

async function main(): Promise<void> {
  const secret = env.hanoiCredentialsSecret.trim();
  if (!secret) {
    console.error("[verify-ky2] Thiếu HANOI_CREDENTIALS_SECRET");
    process.exit(1);
  }

  const hanoiRepo = new HanoiAccountRepository();
  const contractRepo = new HanoiContractRepository();
  const billRepo = new ElectricityBillRepository();

  const wantMa = (process.env.HANOI_VERIFY_MA_KH ?? "").trim().toUpperCase();
  const account = (await hanoiRepo.listEnabled(0, 1))[0] ?? null;
  if (!account?._id) {
    console.error("[verify-ky2] Không có tài khoản Hanoi enabled (hoặc sai HANOI_VERIFY_MA_KH).");
    process.exit(1);
  }

  const accountId = account._id;
  const password = decryptHanoiPassword(account.passwordEncrypted, secret);
  console.info(`[verify-ky2] Account: ${account.username} (${accountId.toHexString()})`);

  const token = await getOrRefreshHanoiAccessToken(account, accountId, password, hanoiRepo, secret);
  const userInfo = await ensureHanoiUserInfo(account, accountId, token, hanoiRepo);

  const contracts = await contractRepo.findByAccountId(accountId);
  let pairs = buildPairs(contracts, userInfo);
  if (wantMa) {
    pairs = pairs.filter((p) => p.maKh.toUpperCase() === wantMa);
  }
  if (pairs.length === 0) {
    console.error("[verify-ky2] Không có cặp (maDvql, maKh) — đồng bộ hợp đồng trước.");
    process.exit(1);
  }

  console.info(
    `[verify-ky2] Tra cứu gộp ky=1..3 URL — tháng ${THANG}/${NAM}, tìm dòng ky=${KY_TARGET}…`,
  );

  let chosen: {
    row: HanoiDmThongTinHoaDonItem;
    maDvql: string;
    maKh: string;
  } | null = null;

  for (const pair of pairs) {
    const rows = await mergeTraCuuForMonth(token, pair);
    const hit = rows.find(
      (r) => r.ky === KY_TARGET && r.thang === THANG && r.nam === NAM,
    );
    console.info(
      `[verify-ky2]   ${pair.maDvql}+${pair.maKh}: ${rows.length} dòng (sau dedupe), ky trong tháng: ${[...new Set(rows.map((x) => x.ky))].sort().join(",")}`,
    );
    if (hit) {
      chosen = { row: hit, maDvql: pair.maDvql, maKh: pair.maKh };
      break;
    }
  }

  if (!chosen) {
    console.warn(
      `[verify-ky2] Không có hóa đơn kỳ ${KY_TARGET} T${THANG}/${NAM} trên các cặp đã thử — đổi HANOI_VERIFY_THANG/NAM/KY hoặc đợi EVN phát hành.`,
    );
    process.exit(0);
  }

  const { row, maDvql, maKh } = chosen;
  const maDvqlPdf = (row.maDonViQuanLy ?? maDvql).trim();
  const maKhPdf = (row.maKhang ?? maKh).trim();
  const loaiTd = (row.loaiHdon || env.hanoiPdfLoaiTienDien).trim() || "TD";
  const idHdonStr = String(row.idHdon);

  console.info(
    `[verify-ky2] Chọn idHdon=${row.idHdon} ky=${row.ky} loaiTd=${loaiTd} maDvql=${maDvqlPdf} maKh=${maKhPdf}`,
  );

  console.info("[verify-ky2] GET XemHoaDonByMaKhachHang (loai=TD) — một file PDF (TB + GTGT trong cùng file)…");
  const buf = await fetchHanoiXemHoaDonPdf(token, {
    maDvql: maDvqlPdf,
    maKh: maKhPdf,
    idHoaDon: row.idHdon,
    loaiHoaDon: loaiTd,
  });
  console.info(`[verify-ky2]   → ${buf.length} bytes (một PDF)`);

  const keyTd = hanoiBillKey(idHdonStr, "tien_dien");
  const keyGt = hanoiBillKey(idHdonStr, "gtgt");
  const dbTd = await billRepo.findByBillKey(keyTd);
  const dbGt = await billRepo.findByBillKey(keyGt);
  console.info("[verify-ky2] DB electricity_bills:");
  console.info(
    `    ${keyTd}: ${dbTd != null ? `status=${dbTd.status} kyBill=${dbTd.kyBill?.ky}/${dbTd.kyBill?.thang}/${dbTd.kyBill?.nam}` : "chưa có"}`,
  );
  console.info(
    `    ${keyGt}: ${dbGt != null ? `status=${dbGt.status} kyBill=${dbGt.kyBill?.ky}/${dbGt.kyBill?.thang}/${dbGt.kyBill?.nam}` : "chưa có"}`,
  );
  if (dbTd?.kyBill?.ky === KY_TARGET && dbTd.kyBill.thang === THANG && dbTd.kyBill.nam === NAM) {
    console.info("[verify-ky2]   ✓ Bản ghi TD khớp kỳ/tháng/năm yêu cầu.");
  } else if (dbTd) {
    console.info(
      `[verify-ky2]   (TD trong DB là kỳ khác hoặc chưa parse — chạy worker quét tháng để đồng bộ.)`,
    );
  }

  console.info("[verify-ky2] Hoàn tất.");
}

main().catch((e) => {
  console.error("[verify-ky2]", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
