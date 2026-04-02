import { env } from "../../config/env.js";
import type {
  HanoiContractNormalized,
  HanoiGetDanhSachHopDongResponse,
} from "../../types/hanoiHopDong.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const REFERER_PATH = "/dashboard/home/quan-ly-chung";

/**
 * Trích mảng hợp đồng từ `data` — hỗ trợ data là mảng, hoặc object chứa *List / *Items.
 */
export function extractHopDongRowsFromResponse(data: unknown): Record<string, unknown>[] {
  if (data == null) return [];
  if (Array.isArray(data)) {
    return data.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
  }
  if (typeof data !== "object") return [];
  const o = data as Record<string, unknown>;

  const preferKeys = Object.keys(o).filter((k) =>
    /hopdong|hopDong|HopDong|khachhang|KhachHang|list|List|items|Items|dm/i.test(k),
  );
  for (const key of preferKeys) {
    const v = o[key];
    if (Array.isArray(v)) {
      return v.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
    }
  }
  for (const v of Object.values(o)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
      return v as Record<string, unknown>[];
    }
  }
  return [];
}

function pickStr(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/**
 * Chuẩn hóa mã KH từ một dòng API (nhiều alias thường gặp).
 */
export function extractMaKhachHangFromRow(row: Record<string, unknown>): string | undefined {
  const s = pickStr(row, [
    "maKhang",
    "maKhachHang",
    "maKH",
    "ma_khang",
    "MA_KHANG",
    "customerCode",
    "maKh",
  ]);
  return s ? s.toUpperCase() : undefined;
}

export function normalizeHopDongRow(row: Record<string, unknown>): HanoiContractNormalized {
  return {
    maDvql: pickStr(row, ["maDvql", "ma_dvi_qly", "maDViQLy", "maDonViQuanLy"]),
    tenKhachHang: pickStr(row, ["tenKhang", "tenKH", "tenKhachHang", "tenKHANG", "hoTen"]),
    diaChi: pickStr(row, ["diaChi", "dchi", "DCHI_KHANG", "diaChiKH"]),
    maSoGCS: pickStr(row, ["maSogcs", "maSoGCS", "MA_SOGCS", "soGCS"]),
    soHopDong: pickStr(row, ["soHopDong", "soHD", "so_hd"]),
  };
}

/**
 * GET danh sách hợp đồng / KH theo user đăng nhập (Bearer).
 */
export async function fetchHanoiDanhSachHopDong(accessToken: string): Promise<{
  response: HanoiGetDanhSachHopDongResponse;
  rows: Record<string, unknown>[];
}> {
  const base = env.evnHanoiBaseUrl.replace(/\/$/, "");
  const url = `${base}/api/TraCuu/GetDanhSachHopDongByUserName`;
  const referer = `${base}${REFERER_PATH}`;
  const timeoutMs = Math.max(10_000, env.hanoiHopDongTimeoutMs);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      Referer: referer,
      "User-Agent": DEFAULT_UA,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`HANOI GetDanhSachHopDong HTTP ${res.status} — ${text.slice(0, 500)}`);
  }

  let parsed: HanoiGetDanhSachHopDongResponse;
  try {
    parsed = JSON.parse(text) as HanoiGetDanhSachHopDongResponse;
  } catch {
    throw new Error("HANOI GetDanhSachHopDong: phản hồi không phải JSON");
  }

  if (parsed.isError === true) {
    throw new Error(`HANOI GetDanhSachHopDong: ${parsed.message ?? "isError"}`);
  }

  const rows = extractHopDongRowsFromResponse(parsed.data);
  return { response: parsed, rows };
}
