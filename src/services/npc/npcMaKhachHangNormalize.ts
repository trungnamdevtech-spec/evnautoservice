/**
 * Chuẩn hóa mã khách hàng NPC (CSKH miền Bắc) từ input người dùng / agent:
 * khoảng trắng thừa, ký tự Unicode, ghép mã + số tiền, nhiều mã trong một chuỗi.
 *
 * **Không** giới hạn chỉ tiền tố `PA` — NPC có nhiều đơn vị: `PA…`, `PE…`, `PNGV…`, `PD…`, …
 * Quy ước: **2–6 chữ cái Latin** + **ít nhất 6 ký tự chữ/số** (đủ dài để tránh khớp nhầm, tương đương quy tắc cũ với `PA` + 6).
 */

export type NpcMaKhNormalizeResult =
  | { ok: true; ma: string }
  | { ok: false; code: NpcMaKhNormalizeErrorCode; message: string };

export type NpcMaKhNormalizeErrorCode =
  | "VALIDATION_MA_KH_EMPTY"
  | "VALIDATION_MA_KH_AMBIGUOUS"
  | "VALIDATION_MA_KH_FORMAT"
  | "VALIDATION_MA_KH_DOTTED_NUMBER";

/**
 * Phần đầu: mã đơn vị / vùng NPC (2–6 chữ). Phần sau: ít nhất 6 ký tự chữ/số (vd. PNGV000020628, PA02HH0043104).
 */
const NPC_MA_PREFIX = "[A-Z]{2,6}";
const NPC_MA_SUFFIX = "[A-Z0-9]{6,}";
const NPC_MA_KH_CORE = new RegExp(`\\b(${NPC_MA_PREFIX}${NPC_MA_SUFFIX})\\b`, "gi");
const NPC_MA_KH_SINGLE = new RegExp(`^${NPC_MA_PREFIX}${NPC_MA_SUFFIX}$`, "i");

/** Số định danh dạng xxx.xxx.xxx — không phải MA_KH (thường gửi nhầm). */
const DOTTED_NUMBER_ONLY = /^\d{1,3}(\.\d{3}){1,5}$/;

/**
 * Gộp mọi khoảng trắng (space thường, NBSP, zero-width, ideographic space U+3000, …) rồi trim.
 * Dùng trước khi tra `npc_accounts` hoặc parse mã KH.
 */
export function normalizeNpcFieldWhitespace(input: string): string {
  let s = input.replace(/\u00A0/g, " ");
  s = s.replace(/[\u2000-\u200B\uFEFF]/g, "");
  s = s.replace(/\u3000/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function normalizeUnicodeWhitespace(input: string): string {
  return normalizeNpcFieldWhitespace(input);
}

const FORMAT_HINT =
  "Mã NPC miền Bắc thường bắt đầu bằng 2–6 chữ cái (vd. PA, PE, PNGV, …) rồi chữ/số — tối thiểu đủ dài (vd. PNGV000020628). Bỏ số tiền, ghi chú; chỉ gửi một mã.";

/**
 * Trích đúng một mã NPC từ chuỗi có thể chứa số tiền, ghi chú, khoảng trắng thừa.
 * - Một mã hợp lệ duy nhất (có thể lặp lại giống hệt) → ok.
 * - Hai mã khác nhau → ambiguous.
 * - Chuỗi chỉ là số dạng chấm (vd. 139.092.077) → gợi ý dùng mã KH.
 * - Không có mã hợp lệ → lỗi định dạng.
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
        "Chuỗi giống số định danh dạng chấm (vd. xxx.xxx.xxx), không phải mã khách hàng NPC. Chỉ gửi mã trên hóa đơn / CSKH (vd. PA…, PNGV…).",
    };
  }

  /** Một mã thuần (không khoảng trắng giữa các phần — tránh dính hai mã khi xóa space). */
  const hasInternalWhitespace = /\s/.test(s);
  if (!hasInternalWhitespace && NPC_MA_KH_SINGLE.test(s)) {
    return { ok: true, ma: s.toUpperCase() };
  }

  const matches = [...s.matchAll(NPC_MA_KH_CORE)];
  const codes = matches.map((m) => m[1]!.toUpperCase());
  if (codes.length === 0) {
    return {
      ok: false,
      code: "VALIDATION_MA_KH_FORMAT",
      message: `Không tìm thấy mã khách hàng NPC hợp lệ. ${FORMAT_HINT}`,
    };
  }

  const uniq = new Set(codes);
  if (uniq.size > 1) {
    return {
      ok: false,
      code: "VALIDATION_MA_KH_AMBIGUOUS",
      message:
        "Chuỗi chứa nhiều mã khách hàng NPC khác nhau — chỉ gửi đúng một mã (không ghép nhiều mã hoặc mã + số tiền trong cùng trường).",
    };
  }

  return { ok: true, ma: codes[0]! };
}

/**
 * Chuẩn hóa username / MA_KH để tra DB (`findByUsername`, ensure-bill, query GET).
 * Trích một mã hợp lệ nếu có; không thì uppercase chuỗi đã bỏ khoảng trắng thừa.
 */
export function normalizeNpcUsernameForLookup(raw: string): string {
  const s = normalizeNpcFieldWhitespace(raw);
  if (!s) return "";
  const parsed = normalizeNpcMaKhachHangInput(s);
  if (parsed.ok) return parsed.ma;
  return s.toUpperCase();
}
