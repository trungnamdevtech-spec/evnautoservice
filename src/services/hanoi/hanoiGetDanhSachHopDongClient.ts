import { env } from "../../config/env.js";
import type {
  HanoiContractNormalized,
  HanoiGetDanhSachHopDongResponse,
} from "../../types/hanoiHopDong.js";
import { buildHanoiApiAuthHeaders } from "./hanoiApiHeaders.js";

/** Khớp curl / web — cùng path với `HANOI_GET_THONG_TIN_HOA_DON_REFERER_PATH` (tra cứu hóa đơn). */
const HOP_DONG_REFERER_PATH = "/dashboard/home/quan-ly-hoa-don/tra-cuu-hoa-don";

/**
 * Trích mảng hợp đồng từ `data`.
 * API EVN Hà Nội: `{ data: { thongTinHopDongDtos: [...] } }`.
 */
export function extractHopDongRowsFromResponse(data: unknown): Record<string, unknown>[] {
  if (data == null) return [];
  if (Array.isArray(data)) {
    return data.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
  }
  if (typeof data !== "object") return [];
  const o = data as Record<string, unknown>;

  const dtoList = o["thongTinHopDongDtos"];
  if (Array.isArray(dtoList)) {
    return dtoList.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
  }

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

/** Kiểm tra phản hồi JSON sau GET GetDanhSachHopDong (envelope + `thongTinHopDongDtos` + extract). */
export interface HanoiHopDongValidationResult {
  ok: boolean;
  reasons: string[];
  thongTinHopDongDtosLength: number;
  extractedRowsLength: number;
  firstRowHasMaKh: boolean;
}

export function validateHanoiHopDongResponse(
  parsed: HanoiGetDanhSachHopDongResponse,
): HanoiHopDongValidationResult {
  const reasons: string[] = [];
  if (parsed.isError === true) {
    return {
      ok: false,
      reasons: [`isError: ${String(parsed.message ?? "")}`],
      thongTinHopDongDtosLength: 0,
      extractedRowsLength: 0,
      firstRowHasMaKh: false,
    };
  }

  const data = parsed.data;
  let thongTinHopDongDtosLength = 0;
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    const arr = (data as Record<string, unknown>)["thongTinHopDongDtos"];
    if (Array.isArray(arr)) thongTinHopDongDtosLength = arr.length;
  }

  const rows = extractHopDongRowsFromResponse(data);
  if (thongTinHopDongDtosLength > 0 && thongTinHopDongDtosLength !== rows.length) {
    reasons.push(
      `thongTinHopDongDtos.length (${thongTinHopDongDtosLength}) !== extractHopDongRows (${rows.length})`,
    );
  }

  const firstRowHasMaKh = rows[0] != null && extractMaKhachHangFromRow(rows[0]) != null;
  if (rows.length > 0 && !firstRowHasMaKh) {
    reasons.push("Có dòng extract nhưng dòng đầu thiếu maKhachHang");
  }

  if (rows.length > 0) {
    const r0 = rows[0]!;
    const dv = r0["maDonViQuanLy"] ?? r0["maDvql"];
    if (dv == null || String(dv).trim() === "") {
      reasons.push("Dòng đầu thiếu maDonViQuanLy/maDvql");
    }
  }

  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, "thongTinHopDongDtos") && rows.length > 0) {
      reasons.push(
        "data không có key thongTinHopDongDtos (API đổi shape?) — extract vẫn có dòng",
      );
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    thongTinHopDongDtosLength,
    extractedRowsLength: rows.length,
    firstRowHasMaKh,
  };
}

function pickStr(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickNum(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function pickBool(row: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

/** `namSinh` có thể null hoặc chuỗi năm. */
function pickNamSinh(row: Record<string, unknown>): string | undefined {
  const v = row["namSinh"];
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
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
    id: pickStr(row, ["id"]),
    maDvql: pickStr(row, ["maDonViQuanLy", "maDvql", "ma_dvi_qly", "maDViQLy"]),
    tenKhachHang: pickStr(row, ["tenKhachHang", "tenKhang", "tenKH", "tenKHANG", "hoTen"]),
    diaChi: pickStr(row, ["diaChiDungDien", "diaChi", "dchi", "DCHI_KHANG", "diaChiKH"]),
    maSoGCS: pickStr(row, ["maSogcs", "maSoGCS", "MA_SOGCS", "soGCS"]),
    soHopDong: pickStr(row, ["soHopDong", "soHD", "so_hd"]),
    dienThoai: pickStr(row, ["dienThoai"]),
    email: pickStr(row, ["email"]),
    maSoThue: pickStr(row, ["maSoThue"]),
    mucDichSuDungDien: pickStr(row, ["mucDichSuDungDien"]),
    soHoSuDungDien: pickNum(row, ["soHoSuDungDien"]),
    loaiKhachHang: pickNum(row, ["loaiKhachHang"]),
    isHopDongChinhChu: pickBool(row, ["isHopDongChinhChu"]),
    isMacDinh: pickBool(row, ["isMacDinh"]),
    trangThaiHopDong: pickNum(row, ["trangThaiHopDong"]),
    dienThoaiNhanTin: pickStr(row, ["dienThoaiNhanTin"]),
    namSinh: pickNamSinh(row),
    soCmt: pickStr(row, ["soCmt"]),
    userNameOld: pickStr(row, ["userNameOld"]),
    userId: pickStr(row, ["userId"]),
  };
}

/**
 * GET `/api/TraCuu/GetDanhSachHopDongByUserName` — Bearer.
 *
 * - `rows`: mỗi phần tử là **một dòng đầy đủ** từ `data` (sau `extractHopDongRowsFromResponse`).
 * - Lưu DB: `hanoi_contracts.raw` = nguyên object dòng đó; `normalized` chỉ là subset tiện tra cứu.
 */
export async function fetchHanoiDanhSachHopDong(accessToken: string): Promise<{
  response: HanoiGetDanhSachHopDongResponse;
  rows: Record<string, unknown>[];
}> {
  const base = env.evnHanoiBaseUrl.replace(/\/$/, "");
  const url = `${base}/api/TraCuu/GetDanhSachHopDongByUserName`;
  const referer = `${base}${HOP_DONG_REFERER_PATH}`;
  const timeoutMs = Math.max(10_000, env.hanoiHopDongTimeoutMs);

  const res = await fetch(url, {
    method: "GET",
    headers: buildHanoiApiAuthHeaders(accessToken, referer),
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
