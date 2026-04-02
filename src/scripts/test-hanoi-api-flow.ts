/**
 * Rà soát **các luồng HTTP** mà worker Hanoi dùng (không Playwright):
 *
 *   1) POST `…/connect/token` — STS password grant
 *   2) GET `…/connect/userinfo`
 *   3) GET `…/api/TraCuu/GetDanhSachHopDongByUserName` — đồng bộ `hanoi_contracts`
 *   4) GET `…/api/TraCuu/GetThongTinHoaDon` — **mỗi mã KH** (userinfo + hợp đồng)
 *   4s) Tuỳ chọn: `HANOI_TEST_TRACUU_SWEEP_KY=1` — nếu tổng 0 dòng, quét `ky=1..3` chỉ trên **mã KH đầu**
 *   5) GET `…/api/Cmis/XemHoaDonByMaKhachHang` — một PDF (TB tiền điện + GTGT trong cùng file) khi có `idHdon` hoặc `HANOI_TEST_ID_HDON` + `HANOI_TEST_PDF_MA_KH`
 *   6) Tuỳ chọn: `fetchHanoiOnlinePaymentLink` (GetListThongTinNoKhachHang) — `HANOI_TEST_ONLINE_PAYMENT=1`
 *
 * Usage:
 *   npm run test:hanoi-api-flow
 *   HANOI_TEST_USERNAME=0868555326 npm run test:hanoi-api-flow
 *
 * Biến: HANOI_TEST_TRACUU_* — HANOI_TEST_TRACUU_SWEEP_KY — HANOI_TEST_ID_HDON / HANOI_TEST_PDF_MA_KH —
 *       HANOI_TEST_ONLINE_PAYMENT — HANOI_TEST_SKIP_PDF=1
 *       HANOI_TEST_VERIFY_STS_RAW=1 — gọi thêm POST /connect/token để in expires_in/scope (không dùng cache)
 */
import "dotenv/config";
import { env } from "../config/env.js";
import { HanoiAccountRepository } from "../db/hanoiAccountRepository.js";
import { HanoiContractRepository } from "../db/hanoiContractRepository.js";
import { decryptHanoiPassword } from "../services/crypto/hanoiCredentials.js";
import { fetchHanoiPasswordToken, getOrRefreshHanoiAccessToken } from "../services/hanoi/hanoiTokenClient.js";
import { ensureHanoiUserInfo } from "../services/hanoi/hanoiUserInfoClient.js";
import {
  fetchHanoiDanhSachHopDong,
  normalizeHopDongRow,
  validateHanoiHopDongResponse,
} from "../services/hanoi/hanoiGetDanhSachHopDongClient.js";
import {
  fetchHanoiGetThongTinHoaDon,
  validateHanoiGetThongTinHoaDonResponse,
} from "../services/hanoi/hanoiGetThongTinHoaDonClient.js";
import { fetchHanoiXemHoaDonPdf } from "../services/hanoi/hanoiXemHoaDonPdfClient.js";
import { fetchHanoiOnlinePaymentLink } from "../services/hanoi/hanoiOnlinePaymentLink.js";
import { hanoiHumanPause } from "../services/hanoi/hanoiBrowserLikeHeaders.js";
import type { HanoiUserInfoSnapshot } from "../types/hanoiUserInfo.js";
import type { HanoiContract } from "../types/hanoiHopDong.js";
import type { HanoiHopDongValidationResult } from "../services/hanoi/hanoiGetDanhSachHopDongClient.js";

/**
 * Cặp `(maDvql, maKh)` giống worker — từ `maDonViQuanLy` + `maKhachHang` mỗi hợp đồng; fallback userinfo.
 */
function buildTraCuuPairsForTest(
  userInfo: HanoiUserInfoSnapshot,
  contracts: HanoiContract[],
): Array<{ maDvql: string; maKh: string }> {
  const map = new Map<string, { maDvql: string; maKh: string }>();
  for (const c of contracts) {
    const dv = (c.normalized.maDvql ?? String(c.raw["maDonViQuanLy"] ?? "")).trim();
    const kh = c.maKhachHang?.trim().toUpperCase();
    if (!dv || !kh) continue;
    map.set(`${dv}|${kh}`, { maDvql: dv, maKh: kh });
  }
  if (map.size === 0 && userInfo.maDvql?.trim() && userInfo.maKhachHang?.trim()) {
    const dv = userInfo.maDvql.trim();
    const kh = userInfo.maKhachHang.trim().toUpperCase();
    map.set(`${dv}|${kh}`, { maDvql: dv, maKh: kh });
  }
  return [...map.values()].sort(
    (a, b) => a.maDvql.localeCompare(b.maDvql, "vi") || a.maKh.localeCompare(b.maKh, "vi"),
  );
}

async function main(): Promise<void> {
  const secret = env.hanoiCredentialsSecret.trim();
  if (!secret) {
    console.error("[test-hanoi-api] Thiếu HANOI_CREDENTIALS_SECRET");
    process.exit(1);
  }

  const hanoiRepo = new HanoiAccountRepository();
  const contractRepo = new HanoiContractRepository();

  const wantUser = (process.env.HANOI_TEST_USERNAME ?? "").trim();
  let account = wantUser ? await hanoiRepo.findByUsername(wantUser) : null;
  if (!account && !wantUser) {
    const batch = await hanoiRepo.listEnabled(0, 1);
    account = batch[0] ?? null;
  }
  if (!account?._id) {
    console.error(
      "[test-hanoi-api] Không tìm thấy tài khoản Hanoi enabled. Import trước hoặc đặt HANOI_TEST_USERNAME.",
    );
    process.exit(1);
  }

  const accountId = account._id;
  const username = account.username;
  let hopDongValidation: HanoiHopDongValidationResult | null = null;
  console.info(`[test-hanoi-api] Tài khoản: ${username} (${accountId.toHexString()})`);

  if (!account.enabled || account.disabledReason === "wrong_password") {
    console.error("[test-hanoi-api] Tài khoản tắt hoặc wrong_password — chọn account khác.");
    process.exit(1);
  }

  const password = decryptHanoiPassword(account.passwordEncrypted, secret);

  console.info("[test-hanoi-api] 1) STS password grant…");
  const accessToken = await getOrRefreshHanoiAccessToken(account, accountId, password, hanoiRepo, secret);
  console.info(`[test-hanoi-api]    OK — access_token ~${accessToken.length} ký tự`);
  if (process.env.HANOI_TEST_VERIFY_STS_RAW === "1") {
    const sts = await fetchHanoiPasswordToken(username, password);
    console.info(
      `[test-hanoi-api]    (raw POST /connect/token) expires_in=${sts.expires_in} token_type=${sts.token_type ?? "?"} scope=${sts.scope ?? "?"}`,
    );
  }

  console.info("[test-hanoi-api] 2) GET /connect/userinfo…");
  const userInfo = await ensureHanoiUserInfo(account, accountId, accessToken, hanoiRepo);
  console.info(
    `[test-hanoi-api]    maDvql=${userInfo.maDvql ?? "?"} maKhachHang=${userInfo.maKhachHang ?? "?"} name=${userInfo.name ?? "?"}`,
  );

  console.info("[test-hanoi-api] 3) GET GetDanhSachHopDongByUserName — validate + lưu hanoi_contracts (một request)…");
  const hopFetch = await fetchHanoiDanhSachHopDong(accessToken);
  const hopVal = validateHanoiHopDongResponse(hopFetch.response);
  hopDongValidation = hopVal;
  console.info(
    `[test-hanoi-api]    envelope: thongTinHopDongDtos=${hopVal.thongTinHopDongDtosLength} extracted=${hopVal.extractedRowsLength} firstMaKh=${hopVal.firstRowHasMaKh}`,
  );
  if (hopVal.reasons.length > 0) {
    console.info(`[test-hanoi-api]    validate: ${hopVal.reasons.join(" | ")}`);
  }
  if (!hopVal.ok) {
    throw new Error(`GetDanhSachHopDong: cấu trúc không hợp lệ — ${hopVal.reasons.join("; ")}`);
  }

  const fetchedAtHop = new Date();
  const { inserted: hopInserted, skippedNoMa: hopSkippedNoMa } = await contractRepo.replaceAllForAccount(
    accountId,
    username,
    hopFetch.rows,
    fetchedAtHop,
  );
  await hanoiRepo.setHopDongFetchedAt(accountId, fetchedAtHop);
  console.info(
    `[test-hanoi-api]    DB: inserted=${hopInserted} skippedNoMa=${hopSkippedNoMa} (raw + normalized đầy đủ mỗi dòng)`,
  );

  const contracts = await contractRepo.findByAccountId(accountId);
  console.info(`[test-hanoi-api]    Đọc DB: ${contracts.length} bản ghi hanoi_contracts`);
  if (contracts[0] != null) {
    const c0 = contracts[0];
    const n = normalizeHopDongRow(c0.raw);
    const rawDv = String(c0.raw["maDonViQuanLy"] ?? c0.raw["maDvql"] ?? "");
    const nDv = n.maDvql ?? "";
    if (rawDv && nDv && rawDv.trim() !== nDv.trim()) {
      console.warn(`[test-hanoi-api]    cảnh báo: normalized.maDvql (${nDv}) khác raw.maDonViQuanLy (${rawDv})`);
    } else {
      console.info(`[test-hanoi-api]    mẫu normalized: maDvql=${nDv || "?"} ten=${(n.tenKhachHang ?? "").slice(0, 50)}…`);
    }
  }

  const maKhUserinfo = userInfo.maKhachHang?.trim();
  const traCuuPairs = buildTraCuuPairsForTest(userInfo, contracts);
  let traCuuByPair: Array<{
    maDvql: string;
    maKh: string;
    rows: number;
    code?: number;
    sampleIdHdon?: number;
    error?: string;
  }> = [];

  /** Tham số tra cứu dùng chung bước 4 + 4s (sweep). */
  const defaultKy = 1;
  const defaultThang = 3;
  const defaultNam = 2026;
  const tracuuKy = Math.max(1, Math.min(3, parseInt(process.env.HANOI_TEST_TRACUU_KY ?? String(defaultKy), 10) || defaultKy));
  const tracuuThang = Math.max(1, Math.min(12, parseInt(process.env.HANOI_TEST_TRACUU_THANG ?? String(defaultThang), 10) || defaultThang));
  const tracuuNam = parseInt(process.env.HANOI_TEST_TRACUU_NAM ?? String(defaultNam), 10) || defaultNam;

  if (traCuuPairs.length > 0) {
    console.info(
      `[test-hanoi-api] 4) GET GetThongTinHoaDon — ${traCuuPairs.length} cặp (maDonViQuanLy, maKhachHang) từ hợp đồng / userinfo, tháng ${tracuuThang}/${tracuuNam}, kỳ ${tracuuKy}…`,
    );
    console.info(
      `[test-hanoi-api]    cặp: ${traCuuPairs.map((p) => `${p.maDvql}+${p.maKh}`).join(" | ")}`,
    );

    for (let i = 0; i < traCuuPairs.length; i++) {
      const { maDvql: md, maKh: mk } = traCuuPairs[i]!;
      console.info(`[test-hanoi-api]    4.${i + 1}) maDvql=${md} maKh=${mk} …`);
      try {
        const tra = await fetchHanoiGetThongTinHoaDon(accessToken, {
          maDvql: md,
          maKh: mk,
          thang: tracuuThang,
          nam: tracuuNam,
          ky: tracuuKy,
        });
        const traVal = validateHanoiGetThongTinHoaDonResponse(tra);
        if (!traVal.ok) {
          console.warn(`[test-hanoi-api]       validate GetThongTinHoaDon: ${traVal.reasons.join(" | ")}`);
        }
        const list = tra.data?.dmThongTinHoaDonList ?? [];
        const firstRow = list[0] as { idHdon?: number; ky?: number } | undefined;
        traCuuByPair.push({
          maDvql: md,
          maKh: mk,
          rows: list.length,
          code: tra.code,
          sampleIdHdon: firstRow?.idHdon,
        });
        console.info(`[test-hanoi-api]       isError=${tra.isError} code=${tra.code} rows=${list.length}`);
        if (list.length > 0) {
          console.info(`[test-hanoi-api]       ví dụ idHdon=${firstRow?.idHdon} ky=${firstRow?.ky}`);
        } else if (tracuuThang === 3) {
          console.info(
            "[test-hanoi-api]       0 dòng — thử HANOI_TEST_TRACUU_KY=2 hoặc 3 hoặc HANOI_TEST_TRACUU_SWEEP_KY=1.",
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        traCuuByPair.push({ maDvql: md, maKh: mk, rows: 0, error: msg.slice(0, 300) });
        console.warn(`[test-hanoi-api]       lỗi: ${msg}`);
      }
      if (i < traCuuPairs.length - 1) {
        await hanoiHumanPause(env);
      }
    }
  } else {
    console.warn(
      "[test-hanoi-api] 4) Bỏ qua GetThongTinHoaDon — không có cặp (maDonViQuanLy, maKhachHang) từ hợp đồng hoặc userinfo.",
    );
  }

  const totalTraRows = traCuuByPair.reduce((a, x) => a + (x.error ? 0 : x.rows), 0);
  let kySweepFirstMaKh: Record<string, number> | null = null;
  let sweepSampleIdHdon: { maDvql: string; maKh: string; idHoaDon: number; ky: number } | null = null;
  if (
    process.env.HANOI_TEST_TRACUU_SWEEP_KY === "1" &&
    traCuuPairs.length > 0 &&
    totalTraRows === 0
  ) {
    const firstPair = traCuuPairs[0]!;
    const firstMa = firstPair.maKh;
    const firstDv = firstPair.maDvql;
    console.info(
      `[test-hanoi-api] 4s) Quét ky=1..3 (maDvql=${firstDv} maKh=${firstMa}, tháng ${tracuuThang}/${tracuuNam}) — HANOI_TEST_TRACUU_SWEEP_KY=1…`,
    );
    kySweepFirstMaKh = {};
    for (const k of [1, 2, 3] as const) {
      try {
        const tra = await fetchHanoiGetThongTinHoaDon(accessToken, {
          maDvql: firstDv,
          maKh: firstMa,
          thang: tracuuThang,
          nam: tracuuNam,
          ky: k,
        });
        const traValS = validateHanoiGetThongTinHoaDonResponse(tra);
        if (!traValS.ok) {
          console.warn(`[test-hanoi-api]       validate ky=${k}: ${traValS.reasons.join(" | ")}`);
        }
        const list = tra.data?.dmThongTinHoaDonList ?? [];
        const n = list.length;
        kySweepFirstMaKh[`ky${k}`] = n;
        console.info(`[test-hanoi-api]       ky=${k} → rows=${n}`);
        if (n > 0 && sweepSampleIdHdon == null) {
          const id = (list[0] as { idHdon?: number })?.idHdon;
          if (id != null) {
            sweepSampleIdHdon = { maDvql: firstDv, maKh: firstMa, idHoaDon: id, ky: k };
            console.info(`[test-hanoi-api]       lấy idHdon=${id} để thử PDF (bước 5)`);
          }
        }
      } catch (e) {
        kySweepFirstMaKh[`ky${k}`] = -1;
        console.warn(`[test-hanoi-api]       ky=${k} lỗi: ${e instanceof Error ? e.message : e}`);
      }
      await hanoiHumanPause(env);
    }
  }

  let pdfTdBytes: number | null = null;
  let pdfTdMeta: {
    maDvql: string;
    maKh: string;
    idHoaDon: number;
    source: "tracuu" | "env" | "sweep";
  } | null = null;
  const skipPdf = process.env.HANOI_TEST_SKIP_PDF === "1";
  const fromTra = traCuuByPair.find((x) => x.rows > 0 && x.sampleIdHdon != null && !x.error);
  const manualId = (process.env.HANOI_TEST_ID_HDON ?? "").trim();
  const manualMa = (process.env.HANOI_TEST_PDF_MA_KH ?? "").trim().toUpperCase();
  const manualMaDvql = (process.env.HANOI_TEST_PDF_MA_DVQL ?? "").trim();
  const maDvqlUser = userInfo.maDvql?.trim();
  if (!skipPdf && (traCuuPairs.length > 0 || maDvqlUser || manualMaDvql)) {
    let idHoaDon: number | undefined;
    let maKhPdf: string | undefined;
    let maDvqlPdf: string | undefined;
    let source: "tracuu" | "env" | "sweep" = "tracuu";
    if (fromTra != null && fromTra.sampleIdHdon != null) {
      idHoaDon = fromTra.sampleIdHdon;
      maKhPdf = fromTra.maKh;
      maDvqlPdf = fromTra.maDvql;
      source = "tracuu";
    } else if (sweepSampleIdHdon != null) {
      idHoaDon = sweepSampleIdHdon.idHoaDon;
      maKhPdf = sweepSampleIdHdon.maKh;
      maDvqlPdf = sweepSampleIdHdon.maDvql;
      source = "sweep";
    } else if (manualId && manualMa) {
      idHoaDon = parseInt(manualId, 10);
      maKhPdf = manualMa;
      maDvqlPdf = manualMaDvql || maDvqlUser;
      source = "env";
      if (!Number.isFinite(idHoaDon)) {
        console.warn("[test-hanoi-api] 5) Bỏ qua PDF — HANOI_TEST_ID_HDON không phải số.");
        idHoaDon = undefined;
      }
    }
    if (idHoaDon != null && maKhPdf != null && maDvqlPdf != null) {
      const loai = (process.env.HANOI_TEST_PDF_LOAI ?? env.hanoiPdfLoaiTienDien).trim() || "TD";
      console.info(
        `[test-hanoi-api] 5) GET XemHoaDonByMaKhachHang (PDF loai=${loai}) maDvql=${maDvqlPdf} maKh=${maKhPdf} idHoaDon=${idHoaDon} (${source})…`,
      );
      try {
        const buf = await fetchHanoiXemHoaDonPdf(accessToken, {
          maDvql: maDvqlPdf,
          maKh: maKhPdf,
          idHoaDon,
          loaiHoaDon: loai,
        });
        pdfTdBytes = buf.length;
        pdfTdMeta = { maDvql: maDvqlPdf, maKh: maKhPdf, idHoaDon, source };
        console.info(
          `[test-hanoi-api]    OK — một PDF (TB+GTGT trong cùng file) ${buf.length} bytes`,
        );
      } catch (e) {
        console.warn(`[test-hanoi-api]    PDF lỗi: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      console.info(
        "[test-hanoi-api] 5) Bỏ qua XemHoaDon PDF — không có idHdon từ tra cứu; đặt HANOI_TEST_ID_HDON + HANOI_TEST_PDF_MA_KH hoặc thử HANOI_TEST_TRACUU_SWEEP_KY=1 / đổi tháng-năm.",
      );
    }
  } else if (skipPdf) {
    console.info("[test-hanoi-api] 5) Bỏ qua PDF — HANOI_TEST_SKIP_PDF=1");
  }

  if (process.env.HANOI_TEST_ONLINE_PAYMENT === "1" && userInfo.maDvql?.trim() && maKhUserinfo) {
    console.info("[test-hanoi-api] 6) Link thanh toán (GetListThongTinNoKhachHang)…");
    const pay = await fetchHanoiOnlinePaymentLink(maKhUserinfo, env.hanoiStepTimeoutMs, {
      accessToken,
      maDViQLy: userInfo.maDvql,
    });
    console.info(
      `[test-hanoi-api]    onlinePayment: ${
        pay.ok ? `ok url=${pay.paymentUrl.slice(0, 80)}…` : `fail code=${pay.code} ${pay.reason.slice(0, 120)}`
      }`,
    );
  }

  const summary = {
    username,
    sts: { accessTokenChars: accessToken.length },
    userInfo: {
      maDvql: userInfo.maDvql ?? null,
      maKhachHang: userInfo.maKhachHang ?? null,
      name: userInfo.name ?? null,
      sub: userInfo.sub ?? null,
      preferredUsername: userInfo.preferredUsername ?? null,
    },
    hopDong: {
      contractRowsInDb: contracts.length,
      apiValidation:
        hopDongValidation != null
          ? {
              ok: hopDongValidation.ok,
              thongTinHopDongDtosLength: hopDongValidation.thongTinHopDongDtosLength,
              extractedRowsLength: hopDongValidation.extractedRowsLength,
              firstRowHasMaKh: hopDongValidation.firstRowHasMaKh,
            }
          : null,
      sample:
        contracts[0] != null
          ? {
              maKhachHang: contracts[0].maKhachHang,
              maDvql: contracts[0].normalized.maDvql ?? null,
              maSoGCS: contracts[0].normalized.maSoGCS ?? null,
              tenKhachHang: contracts[0].normalized.tenKhachHang?.slice(0, 80) ?? null,
            }
          : null,
    },
    traCuu: {
      pairs: traCuuByPair,
      totalRows: traCuuByPair.reduce((a, x) => a + (x.error ? 0 : x.rows), 0),
      kySweepFirstMaKh,
    },
    pdfTienDien:
      pdfTdMeta != null
        ? {
            ...pdfTdMeta,
            bytes: pdfTdBytes,
            ...(pdfTdMeta.source === "sweep" && sweepSampleIdHdon != null ? { ky: sweepSampleIdHdon.ky } : {}),
          }
        : null,
  };
  console.info("[test-hanoi-api] ── Tóm tắt (JSON) ──");
  console.info(JSON.stringify(summary, null, 2));
  console.info(
    "[test-hanoi-api] Đã cover endpoint: token, userinfo, GetDanhSachHopDongByUserName, GetThongTinHoaDon" +
      (pdfTdBytes != null ? ", XemHoaDonByMaKhachHang(PDF)" : "") +
      (process.env.HANOI_TEST_ONLINE_PAYMENT === "1" ? ", GetListThongTinNoKhachHang" : "") +
      ".",
  );
  console.info("[test-hanoi-api] Hoàn tất.");
}

main().catch((err) => {
  console.error("[test-hanoi-api] Lỗi:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
