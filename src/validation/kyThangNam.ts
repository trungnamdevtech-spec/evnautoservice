/**
 * Kiểm tra kỳ / tháng / năm cho API worker & NPC (một nguồn thật — tránh lệch thông báo lỗi).
 * - ky: chỉ 1, 2 hoặc 3
 * - thang: 1–12 (số nguyên)
 * - nam: 2020–2100 (số nguyên)
 */

export type ValidatedKyThangNam = {
  ky: string;
  thang: string;
  nam: string;
  kyNum: 1 | 2 | 3;
  thangNum: number;
  namNum: number;
};

export function validateKyThangNam(
  ky: unknown,
  thang: unknown,
  nam: unknown,
): { ok: true; value: ValidatedKyThangNam } | { ok: false; error: string; code: string } {
  const kyN = Number(ky);
  const thangN = Number(thang);
  const namN = Number(nam);

  if (ky === undefined || ky === null || String(ky).trim() === "") {
    return { ok: false, error: "Thiếu tham số ky (bắt buộc: 1, 2 hoặc 3).", code: "VALIDATION_KY_MISSING" };
  }
  if (thang === undefined || thang === null || String(thang).trim() === "") {
    return {
      ok: false,
      error: "Thiếu tham số thang (bắt buộc: số nguyên từ 1 đến 12).",
      code: "VALIDATION_THANG_MISSING",
    };
  }
  if (nam === undefined || nam === null || String(nam).trim() === "") {
    return {
      ok: false,
      error: "Thiếu tham số nam (bắt buộc: số nguyên từ 2020 đến 2100).",
      code: "VALIDATION_NAM_MISSING",
    };
  }

  if (!Number.isInteger(kyN) || kyN < 1 || kyN > 3) {
    return {
      ok: false,
      error: "ky phải là số nguyên 1, 2 hoặc 3 (tối đa 3 kỳ trong tháng).",
      code: "VALIDATION_KY_RANGE",
    };
  }
  if (!Number.isInteger(thangN) || thangN < 1 || thangN > 12) {
    return {
      ok: false,
      error: "thang phải là số nguyên từ 1 đến 12.",
      code: "VALIDATION_THANG_RANGE",
    };
  }
  if (!Number.isInteger(namN) || namN < 2020 || namN > 2100) {
    return {
      ok: false,
      error: "nam phải là số nguyên từ 2020 đến 2100.",
      code: "VALIDATION_NAM_RANGE",
    };
  }

  return {
    ok: true,
    value: {
      ky: String(kyN),
      thang: String(thangN).padStart(2, "0"),
      nam: String(namN),
      kyNum: kyN as 1 | 2 | 3,
      thangNum: thangN,
      namNum: namN,
    },
  };
}
