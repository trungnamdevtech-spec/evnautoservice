import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import type { ElectricityBill, MeterReading, ParseResult, TimeFramePricing } from "../../types/electricityBill.js";

/** Version parser — tăng khi thay đổi logic để biết cần re-parse những file cũ */
export const PARSER_VERSION = 1;

/** Dùng pdf-parse v2: new PDFParse({ data, verbosity }) → getText() → .text */
async function extractPdfText(buffer: Buffer): Promise<string> {
  // pdf-parse v2 typings chưa đầy đủ — cast qua unknown để tránh ts error
  const parser = new (PDFParse as unknown as new (opts: { data: Buffer; verbosity: number }) => {
    getText(): Promise<{ text: string }>;
  })({ data: buffer, verbosity: 0 });
  const result = await parser.getText();
  return result.text;
}

// ─── Helpers số ─────────────────────────────────────────────────────────────

/** "93.981.615" → 93981615 (số nguyên kiểu VN, dấu chấm = phân nghìn) */
function parseVnInt(s: string): number {
  const cleaned = s.trim().replace(/\./g, "").replace(/,.*$/, "");
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) throw new Error(`Không parse được số nguyên: "${s}"`);
  return n;
}

/** "9.355,96" → 9355.96 (số thực kiểu VN: chấm = phân nghìn, phẩy = thập phân) */
function parseVnFloat(s: string): number {
  const cleaned = s.trim().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  if (isNaN(n)) throw new Error(`Không parse được số thực: "${s}"`);
  return n;
}

/** "01/03/2026" → Date */
function parseVnDate(s: string): Date {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`Không parse được ngày: "${s}"`);
  const [, d, mo, y] = m;
  return new Date(`${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}T00:00:00.000Z`);
}

// ─── Regex patterns ──────────────────────────────────────────────────────────

const RE = {
  // Kỳ hóa đơn: "Kỳ hóa đơn: Kỳ 1 3/2026 (15 ngày từ 01/03/2026 đến 15/03/2026 )"
  kyHoaDon: /Kỳ hóa đơn:\s*Kỳ\s*(\d)\s+(\d{1,2})\/(\d{4})\s+\((\d+)\s*ngày\s+từ\s+(\d{2}\/\d{2}\/\d{4})\s+đến\s+(\d{2}\/\d{2}\/\d{4})/,

  // Khách hàng
  tenKhachHang: /Khách hàng\s+(.+?)(?:\n|Địa chỉ)/s,
  diaChiKhachHang: /Địa chỉ\s+(.+?)(?:\n|Điện thoại)/s,
  dienThoaiKhachHang: /Điện thoại\s+([\d\s]+)/,
  emailKhachHang: /Email\s+([\w.@\-]+)/,
  maSoThueKhachHang: /Mã số thuế\s+([\d]+)/,
  diaChiSuDungDien: /Địa chỉ sử dụng điện\s+(.+?)(?:\n|Mục đích)/s,
  mucDichSuDung: /Mục đích sử dụng điện\s+(.+?)(?:\n|Cấp điện áp)/s,
  capDienAp: /Cấp điện áp sử dụng\s+(.+)/,

  // Đơn vị điện lực (4 dòng đầu trước "THÔNG BÁO TIỀN ĐIỆN")
  mstDonVi: /MST:\s*([\d]+)/,
  soTaiKhoan: /Số tài khoản:\s*([\d]+)\s+(.+?)(?:\n|$)/,
  dienThoaiDonVi: /^(19\d{6})\s*$/m,
  ngayKy: /Ngày ký:\s*(\d{2}\/\d{2}\/\d{4})/,
  nguoiKy: /Được ký bởi:\s*(.+?)(?:\n|Ngày ký)/s,

  // Công tơ
  soHieuCongTo: /\n([\d]+)\n(?:Khung giờ bình thường)/,
  heSoNhan: /Khung giờ bình thường\s+([\d]+)\s+/,

  // Chỉ số điện (heSoNhan, chiSoMoi, chiSoCu, tieuThu)
  chiSoBinhThuong: /Khung giờ bình thường\s+([\d]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.]+)/,
  chiSoCaoDiem:    /Khung giờ cao điểm\s+([\d]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.]+)/,
  chiSoThapDiem:   /Khung giờ thấp điểm\s+([\d]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.]+)/,

  // Giá điện (section KHUNG GIỜ MUA ĐIỆN)
  // Sau chữ "THÀNH TIỀN" sẽ có 3 dòng giá
  giaBinhThuong: /Khung giờ bình thường\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\n(?!Khung giờ cao)/,
  giaCaoDiem:    /Khung giờ cao điểm\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/,
  giaThapDiem:   /Khung giờ thấp điểm\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/,

  // Tổng kết
  tongDienNang:      /Tổng điện năng tiêu thụ \(kWh\)\s+([\d.]+)/,
  tongChuaThue:      /Tổng tiền điện chưa thuế \(đồng\)\s+([\d.]+)/,
  thueSuat:          /Thuế suất GTGT\s+([\d]+)%/,
  tienThue:          /Thuế GTGT \(đồng\)\s+([\d.]+)/,
  tongThanhToan:     /Tổng cộng tiền thanh toán \(đồng\)\s+([\d.]+)/,
  bangChu:           /Bằng chữ:\s*(.+?)(?:\n|Mã khách hàng)/s,

  // Thanh toán
  hanThanhToan: /Hạn thanh toán\s*\n?\s*(\d{2}\/\d{2}\/\d{4})/,
};

// ─── Parser chính ────────────────────────────────────────────────────────────

/**
 * Trích xuất text từ file PDF và parse thành `ElectricityBill`.
 * Throw nếu không tìm thấy field bắt buộc.
 */
export async function parseElectricityBillPdf(
  pdfPath: string,
  invoiceId: number,
  maKhachHang: string,
  maDonViQuanLy: string,
  meta: { maSogcs: string; kyHieu: string; soSery: string; ngayPhatHanh: Date },
): Promise<ParseResult> {
  let rawText: string;

  try {
    const buffer = await readFile(pdfPath);
    rawText = await extractPdfText(buffer);
  } catch (err) {
    return {
      success: false,
      error: `Đọc PDF thất bại: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const bill = extractFields(rawText, pdfPath, invoiceId, maKhachHang, maDonViQuanLy, meta);
    return { success: true, bill };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Extraction logic ────────────────────────────────────────────────────────

function extractFields(
  text: string,
  pdfPath: string,
  invoiceId: number,
  maKhachHang: string,
  maDonViQuanLy: string,
  meta: { maSogcs: string; kyHieu: string; soSery: string; ngayPhatHanh: Date },
): ElectricityBill {
  const now = new Date();

  // ── Kỳ hóa đơn ────────────────────────────────────────────────────────────
  const kyMatch = text.match(RE.kyHoaDon);
  if (!kyMatch) throw new Error('Không tìm thấy "Kỳ hóa đơn" trong PDF');
  const [, kyStr, thangStr, namStr, soDaysStr, ngayBDStr, ngayKTStr] = kyMatch;
  const kyBill = {
    ky: parseInt(kyStr!, 10) as 1 | 2 | 3,
    thang: parseInt(thangStr!, 10),
    nam: parseInt(namStr!, 10),
    ngayBatDau: parseVnDate(ngayBDStr!),
    ngayKetThuc: parseVnDate(ngayKTStr!),
    soDays: parseInt(soDaysStr!, 10),
  };

  // ── Đơn vị điện lực ───────────────────────────────────────────────────────
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // Tên công ty ở dòng 1 (sau "THÔNG TIN LIÊN HỆ")
  const lhIdx = lines.findIndex((l) => l.includes("THÔNG TIN LIÊN HỆ"));
  const tenDonVi = lhIdx >= 0 ? (lines[lhIdx + 1] ?? "") : "";
  const tenDienLuc = lhIdx >= 0 ? (lines[lhIdx + 2] ?? "") : "";
  const diaChiDonVi = lhIdx >= 0 ? (lines[lhIdx + 3] ?? "") : "";

  const mstDonViMatch = text.match(RE.mstDonVi);
  const soTaiKhoanMatch = text.match(RE.soTaiKhoan);
  const dienThoaiDonViMatch = text.match(RE.dienThoaiDonVi);
  const ngayKyMatch = text.match(RE.ngayKy);
  const nguoiKyMatch = text.match(RE.nguoiKy);

  const donViDien = {
    ten: tenDonVi.replace(/\bCHI NHÁNH.*$/i, "").trim(),
    tenDienLuc,
    diaChi: diaChiDonVi,
    maSoThue: mstDonViMatch?.[1] ?? "",
    soTaiKhoan: soTaiKhoanMatch?.[1] ?? "",
    nganHang: soTaiKhoanMatch?.[2]?.trim() ?? "",
    dienThoai: dienThoaiDonViMatch?.[1] ?? "",
  };

  // ── Khách hàng ────────────────────────────────────────────────────────────
  const tenKHRaw = text.match(RE.tenKhachHang)?.[1] ?? "";
  const diaChiKHRaw = text.match(RE.diaChiKhachHang)?.[1] ?? "";
  const mucDichRaw = text.match(RE.mucDichSuDung)?.[1] ?? "";
  const diaChiSuDungRaw = text.match(RE.diaChiSuDungDien)?.[1] ?? "";

  const khachHang = {
    ten: normalizeMultiline(tenKHRaw),
    diaChi: normalizeMultiline(diaChiKHRaw),
    dienThoai: text.match(RE.dienThoaiKhachHang)?.[1]?.trim() ?? "",
    email: text.match(RE.emailKhachHang)?.[1]?.trim() ?? "",
    maSoThue: text.match(RE.maSoThueKhachHang)?.[1]?.trim() ?? "",
    diaChiSuDungDien: normalizeMultiline(diaChiSuDungRaw),
    mucDichSuDung: mucDichRaw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    capDienAp: text.match(RE.capDienAp)?.[1]?.trim() ?? "",
  };

  // ── Công tơ ───────────────────────────────────────────────────────────────
  // Số hiệu công tơ nằm ngay trên dòng "Khung giờ bình thường"
  const soHieuMatch = text.match(RE.soHieuCongTo);
  const heSoNhanMatch = text.match(RE.heSoNhan);
  const heSoNhan = heSoNhanMatch ? parseInt(heSoNhanMatch[1]!, 10) : 1;

  const congTo = {
    soHieu: soHieuMatch?.[1] ?? "",
    heSoNhan,
  };

  // ── Chỉ số điện ───────────────────────────────────────────────────────────
  // Phần công tơ: "Kỳ hóa đơn:..." đến "KHUNG GIỜ MUA ĐIỆN"
  const sectionCongTo = text.split("KHUNG GIỜ MUA ĐIỆN")[0] ?? text;

  const chiSoDien = {
    binhThuong: parseMeterReading(sectionCongTo, RE.chiSoBinhThuong, heSoNhan),
    caoDiem: parseMeterReading(sectionCongTo, RE.chiSoCaoDiem, heSoNhan),
    thapDiem: parseMeterReading(sectionCongTo, RE.chiSoThapDiem, heSoNhan),
  };

  // ── Giá điện ─────────────────────────────────────────────────────────────
  // Phần giá: từ "KHUNG GIỜ MUA ĐIỆN" đến "Tổng điện năng"
  const sectionGia = text.split("KHUNG GIỜ MUA ĐIỆN")[1] ?? "";

  const giaDien = {
    binhThuong: parsePricing(sectionGia, /Khung giờ bình thường\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/),
    caoDiem:    parsePricing(sectionGia, RE.giaCaoDiem),
    thapDiem:   parsePricing(sectionGia, RE.giaThapDiem),
  };

  // ── Tổng kết ──────────────────────────────────────────────────────────────
  const bangChuRaw = text.match(RE.bangChu)?.[1] ?? "";
  const tongKet = {
    tongDienNangTieuThu: parseVnInt(matchRequired(text, RE.tongDienNang, "Tổng điện năng")),
    tongTienDienChuaThue: parseVnInt(matchRequired(text, RE.tongChuaThue, "Tổng tiền chưa thuế")),
    thueSuatGTGT: parseInt(matchRequired(text, RE.thueSuat, "Thuế suất GTGT"), 10),
    tienThueGTGT: parseVnInt(matchRequired(text, RE.tienThue, "Thuế GTGT")),
    tongTienThanhToan: parseVnInt(matchRequired(text, RE.tongThanhToan, "Tổng tiền thanh toán")),
    bangChu: bangChuRaw.trim().replace(/\s+/g, " "),
  };

  // ── Hạn thanh toán ────────────────────────────────────────────────────────
  const hanTTStr = matchRequired(text, RE.hanThanhToan, "Hạn thanh toán");
  const hanThanhToan = parseVnDate(hanTTStr);

  // ── Ký hóa đơn ───────────────────────────────────────────────────────────
  const ngayKy = ngayKyMatch ? parseVnDate(ngayKyMatch[1]!) : meta.ngayPhatHanh;
  const nguoiKy = nguoiKyMatch
    ? nguoiKyMatch[1]!.trim().replace(/\s+/g, " ")
    : donViDien.ten;

  return {
    invoiceId,
    maKhachHang,
    maDonViQuanLy,
    kyBill,
    donViDien,
    khachHang,
    congTo,
    chiSoDien,
    giaDien,
    tongKet,
    hanThanhToan,
    soHoaDon: {
      maSogcs: meta.maSogcs,
      kyHieu: meta.kyHieu,
      soSery: meta.soSery,
      ngayPhatHanh: meta.ngayPhatHanh,
      ngayKy,
      nguoiKy,
    },
    pdfPath,
    status: "parsed",
    parseVersion: PARSER_VERSION,
    parsedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Helpers parse ───────────────────────────────────────────────────────────

function matchRequired(text: string, re: RegExp, name: string): string {
  const m = text.match(re);
  if (!m?.[1]) throw new Error(`Không tìm thấy field "${name}" trong PDF`);
  return m[1];
}

function normalizeMultiline(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function parseMeterReading(section: string, re: RegExp, heSoNhan: number): MeterReading {
  const m = section.match(re);
  if (!m) {
    return { chiSoMoi: 0, chiSoCu: 0, tieuThu: 0 };
  }
  // Groups: [1]=heSoNhan, [2]=chiSoMoi, [3]=chiSoCu, [4]=tieuThu
  return {
    chiSoMoi: parseVnFloat(m[2]!),
    chiSoCu: parseVnFloat(m[3]!),
    tieuThu: parseVnInt(m[4]!),
  };
}

function parsePricing(section: string, re: RegExp): TimeFramePricing {
  const m = section.match(re);
  if (!m) {
    return { donGia: 0, sanLuong: 0, thanhTien: 0 };
  }
  return {
    donGia: parseVnInt(m[1]!),
    sanLuong: parseVnInt(m[2]!),
    thanhTien: parseVnInt(m[3]!),
  };
}
