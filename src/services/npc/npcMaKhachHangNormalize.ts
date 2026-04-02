/**
 * Chuẩn hóa mã khách hàng NPC (CSKH) từ input người dùng / agent:
 * khoảng trắng thừa, ký tự Unicode, ghép mã + số tiền, nhiều mã PA trong một chuỗi.
 *
 * Định dạng tham chiếu: `PA` + ít nhất 6 ký tự chữ/số (vd. PA02HH0043104).
 */

export type NpcMaKhNormalizeResult =
  | { ok: true; ma: string }
  | { ok: false; code: NpcMaKhNormalizeErrorCode; message: string };

export type NpcMaKhNormalizeErrorCode =
  | "VALIDATION_MA_KH_EMPTY"
  | "VALIDATION_MA_KH_AMBIGUOUS"
  | "VALIDATION_MA_KH_FORMAT"
  | "VALIDATION_MA_KH_DOTTED_NUMBER";

/** PA + tối thiểu 6 ký tự (đủ phân biệt với mã quá ngắn / nhập nhầm). */
const NPC_MA_KH_CORE = /\b(PA[A-Z0-9]{6,})\b/gi;

/** Số định danh dạng xxx.xxx.xxx — không phải MA_KH PA (thường gửi nhầm). */
const DOTTED_NUMBER_ONLY = /^\d{1,3}(\.\d{3}){1,5}$/;

function normalizeUnicodeWhitespace(input: string): string {
  let s = input.replace(/\u00A0/g, " ");
  s = s.replace(/[\u2000-\u200B\uFEFF]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Trích đúng một mã NPC dạng PA… từ chuỗi có thể chứa số tiền, ghi chú, khoảng trắng thừa.
 * - Một mã PA duy nhất (có thể lặp lại giống hệt) → ok.
 * - Hai mã PA khác nhau → ambiguous.
 * - Chuỗi chỉ là số dạng chấm (vd. 139.092.077) → gợi ý dùng mã PA.
 * - Không có PA hợp lệ → lỗi định dạng.
 */
export function normalizeNpcMaKhachHangInput(raw: string): NpcMaKhNormalizeResult {
  const s = normalizeUnicodeWhitespace(raw);
  if (!s) {
    return {
      ok: false,
      code: "VALIDATION_MA_KH_EMPTY",
      message: "Mã khách hàng NPC (maKhachHang) đang trống.",
    };
  }

  if (DOTTED_NUMBER_ONLY.test(s)) {
    return {
      ok: false,
      code: "VALIDATION_MA_KH_DOTTED_NUMBER",
      message:
        "Chuỗi giống số định danh dạng chấm (vd. xxx.xxx.xxx), không phải mã khách hàng NPC dạng PA (vd. PA02HH0043104). Chỉ gửi mã PA.",
    };
  }

  /** Một mã PA thuần (không có khoảng trắng giữa các phần — tránh dính hai mã khi xóa space). */
  const hasInternalWhitespace = /\s/.test(s);
  if (!hasInternalWhitespace && /^PA[A-Z0-9]+$/i.test(s)) {
    return { ok: true, ma: s.toUpperCase() };
  }

  const matches = [...s.matchAll(NPC_MA_KH_CORE)];
  const codes = matches.map((m) => m[1]!.toUpperCase());
  if (codes.length === 0) {
    return {
      ok: false,
      code: "VALIDATION_MA_KH_FORMAT",
      message:
        "Không tìm thấy mã khách hàng NPC hợp lệ dạng PA… (chữ số sau PA, tối thiểu 6 ký tự). Bỏ số tiền, ghi chú; chỉ gửi một mã PA.",
    };
  }

  const uniq = new Set(codes);
  if (uniq.size > 1) {
    return {
      ok: false,
      code: "VALIDATION_MA_KH_AMBIGUOUS",
      message:
        "Chuỗi chứa nhiều mã khách hàng PA khác nhau — chỉ gửi đúng một mã PA (không ghép nhiều mã hoặc mã + số tiền trong cùng trường).",
    };
  }

  return { ok: true, ma: codes[0]! };
}
