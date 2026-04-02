/**
 * Gọi thử GET `/api/TraCuu/GetThongTinHoaDon` với tham số cố định (mặc định như curl mẫu).
 *
 * Không commit token/mật khẩu. Một trong các cách lấy Bearer:
 *   - `HANOI_TEST_BEARER_TOKEN` — paste token tạm (DevTools / STS)
 *   - `HANOI_TEST_USERNAME` + `HANOI_TEST_PASSWORD` — POST /connect/token
 *   - `HANOI_TEST_USE_DB=1` + `HANOI_TEST_USERNAME` — tài khoản trong `hanoi_accounts` + `HANOI_CREDENTIALS_SECRET`
 *
 * Tham số tra cứu (mặc định = curl bạn gửi):
 *   HANOI_TRACUU_MA_DVQL=HN0400
 *   HANOI_TRACUU_MA_KH=HN04000000565
 *   HANOI_TRACUU_THANG=3 HANOI_TRACUU_NAM=2026 HANOI_TRACUU_KY=1
 *
 * Usage:
 *   npm run test:hanoi-tracuu-params
 */
import "dotenv/config";
import { env } from "../config/env.js";
import { HanoiAccountRepository } from "../db/hanoiAccountRepository.js";
import { decryptHanoiPassword } from "../services/crypto/hanoiCredentials.js";
import { fetchHanoiPasswordToken } from "../services/hanoi/hanoiTokenClient.js";
import { getOrRefreshHanoiAccessToken } from "../services/hanoi/hanoiTokenClient.js";
import {
  fetchHanoiGetThongTinHoaDonIncludingBusinessError,
  validateHanoiGetThongTinHoaDonResponse,
} from "../services/hanoi/hanoiGetThongTinHoaDonClient.js";

function parseIntEnv(name: string, fallback: number): number {
  const v = (process.env[name] ?? "").trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function resolveBearer(): Promise<{ token: string; source: string }> {
  const bearer = (process.env.HANOI_TEST_BEARER_TOKEN ?? "").trim();
  if (bearer) {
    return { token: bearer, source: "HANOI_TEST_BEARER_TOKEN" };
  }

  const user = (process.env.HANOI_TEST_USERNAME ?? "").trim();
  const pass = (process.env.HANOI_TEST_PASSWORD ?? "").trim();
  if (user && pass) {
    const t = await fetchHanoiPasswordToken(user, pass);
    return { token: t.access_token, source: "STS password grant (username+password)" };
  }

  if (process.env.HANOI_TEST_USE_DB === "1" && user) {
    const secret = env.hanoiCredentialsSecret.trim();
    if (!secret) throw new Error("Thiếu HANOI_CREDENTIALS_SECRET khi HANOI_TEST_USE_DB=1");
    const repo = new HanoiAccountRepository();
    const account = await repo.findByUsername(user);
    if (!account?._id) throw new Error(`Không tìm thấy hanoi_accounts username=${user}`);
    const password = decryptHanoiPassword(account.passwordEncrypted, secret);
    const token = await getOrRefreshHanoiAccessToken(account, account._id, password, repo, secret);
    return { token, source: "MongoDB hanoi_accounts + getOrRefreshHanoiAccessToken" };
  }

  throw new Error(
    "Cần một trong: HANOI_TEST_BEARER_TOKEN | (HANOI_TEST_USERNAME + HANOI_TEST_PASSWORD) | (HANOI_TEST_USE_DB=1 + HANOI_TEST_USERNAME + MongoDB account)",
  );
}

async function main(): Promise<void> {
  const maDvql = (process.env.HANOI_TRACUU_MA_DVQL ?? "HN0400").trim();
  const maKh = (process.env.HANOI_TRACUU_MA_KH ?? "HN04000000565").trim();
  const thang = parseIntEnv("HANOI_TRACUU_THANG", 3);
  const nam = parseIntEnv("HANOI_TRACUU_NAM", 2026);
  const ky = Math.max(1, Math.min(3, parseIntEnv("HANOI_TRACUU_KY", 1)));

  console.info(
    `[tracuu-params] GET GetThongTinHoaDon maDvql=${maDvql} maKh=${maKh} thang=${thang} nam=${nam} ky=${ky}`,
  );

  const { token, source } = await resolveBearer();
  console.info(`[tracuu-params] Bearer: ${source} (~${token.length} ký tự)`);

  const resp = await fetchHanoiGetThongTinHoaDonIncludingBusinessError(token, {
    maDvql,
    maKh,
    thang,
    nam,
    ky,
  });
  const val = validateHanoiGetThongTinHoaDonResponse(resp);

  console.info(
    `[tracuu-params] isError=${resp.isError} code=${resp.code ?? "?"} validateOk=${val.ok} listLength=${val.listLength}`,
  );
  if (resp.message) console.info(`[tracuu-params] message (API): ${resp.message}`);
  if (val.reasons.length > 0) console.info(`[tracuu-params] validate: ${val.reasons.join(" | ")}`);

  const list = resp.data?.dmThongTinHoaDonList ?? [];
  if (list.length > 0) {
    const r0 = list[0]!;
    console.info(
      `[tracuu-params] dòng 0: idHdon=${r0.idHdon} ky=${r0.ky} thang=${r0.thang} nam=${r0.nam} loaiHdon=${r0.loaiHdon} soTien=${r0.soTien}`,
    );
  } else {
    console.info("[tracuu-params] dmThongTinHoaDonList rỗng — có thể kỳ/tháng không có dữ liệu hoặc mã KH không thuộc quyền user.");
  }

  const preview = {
    source,
    query: { maDvql, maKh, thang, nam, ky },
    response: {
      isError: resp.isError,
      code: resp.code,
      message: resp.message,
      rowCount: list.length,
      firstRow:
        list[0] != null
          ? {
              idHdon: list[0]!.idHdon,
              ky: list[0]!.ky,
              thang: list[0]!.thang,
              nam: list[0]!.nam,
              maKhang: list[0]!.maKhang,
              loaiHdon: list[0]!.loaiHdon,
            }
          : null,
    },
  };
  console.info("[tracuu-params] ── JSON (không gồm raw list đầy đủ) ──");
  console.info(JSON.stringify(preview, null, 2));
}

main().catch((e) => {
  console.error("[tracuu-params]", e instanceof Error ? e.message : e);
  process.exit(1);
});
