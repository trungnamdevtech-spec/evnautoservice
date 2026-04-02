import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import type {
  ElectricityBill,
  ElectricityProvider,
  MeterReading,
  ParseResult,
  ThreeFrames,
  TimeFramePricing,
} from "../../types/electricityBill.js";
import type { NpcPdfKind } from "../npc/npcElectricityBillId.js";
import { npcBillKey } from "../npc/npcElectricityBillId.js";
import type { HanoiPdfKind } from "../hanoi/hanoiElectricityBillId.js";
import { hanoiBillKey } from "../hanoi/hanoiElectricityBillId.js";

/**
 * Version parser — tăng khi thay đổi logic để biết cần re-parse những file cũ.
 * v2: Hỗ trợ PDF CSKH NPC (miền Bắc) — cùng khung bố cục CPC nhưng khác biệt nhỏ (Kỳ hóa đơn có dấu "-",
 * thứ tự dòng công tơ, serial trước "Khung giờ thấp điểm", Ngày ký có khoảng trắng, MST có "-").
 * v3: NPC một số mẫu dùng `Kỳ hóa đơn: Tháng mm/yyyy (...)` (không có chữ "Kỳ n") — cần `npc.kyTrongKy` từ tên file/API.
 * v4: PDF hóa đơn thanh toán NPC (`XemHoaDon_NPC`) — mẫu HĐ GTGT / VAT, không có dòng `Kỳ hóa đơn` (khác PDF thông báo).
 * v5: EVN Hà Nội — cùng mẫu parse với NPC/CPC (shim qua `npc` + `applyHanoiBillOverrides`).
 */
export const PARSER_VERSION = 5;

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
  /**
   * CPC: `Kỳ hóa đơn: Kỳ 3 1/2026 (11 ngày …)`
   * NPC: `Kỳ hóa đơn: Kỳ 1 - 3/2026 (10 ngày …)` — có dấu "-" trước tháng/năm.
   */
  kyHoaDon:
    /Kỳ hóa đơn:\s*Kỳ\s*(\d)\s*(?:-\s*)?(\d{1,2})\/(\d{4})\s+\((\d+)\s*ngày\s+từ\s+(\d{2}\/\d{2}\/\d{4})\s+đến\s+(\d{2}\/\d{2}\/\d{4})\s*\)/,
  /** NPC: `Kỳ hóa đơn: Tháng 2/2026 (28 ngày từ …)` — không có "Kỳ 1|2|3" trong PDF */
  kyHoaDonThang:
    /Kỳ hóa đơn:\s*Tháng\s+(\d{1,2})\/(\d{4})\s+\((\d+)\s*ngày\s+từ\s+(\d{2}\/\d{2}\/\d{4})\s+đến\s+(\d{2}\/\d{2}\/\d{4})\s*\)/,

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
  mstDonVi: /MST:\s*([\d\-]+)/,
  soTaiKhoan: /Số tài khoản:\s*([\d]+)\s+(.+?)(?:\n|$)/,
  dienThoaiDonVi: /^(19\d{6})\s*$/m,
  // NPC: `Ngày ký: 12/ 03/ 2026 10:55:18` — cho phép khoảng trắng quanh /
  ngayKy: /Ngày ký:\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/,
  nguoiKy: /Được ký bởi:\s*(.+?)(?:\n|Ngày ký)/s,

  /**
   * Số công tơ: dòng chỉ gồm chữ số, ngay trước dòng đầu "Khung giờ …"
   * (CPC thường là bình thường trước; NPC thường là thấp điểm trước — không ép thứ tự).
   */
  soHieuCongTo: /\n(\d{6,})\s*\r?\n\s*Khung giờ\s+/,
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
export interface ParseElectricityBillPdfOptions {
  /**
   * Khi parse PDF từ CSKH NPC — gắn provider + billKey + npcIdHdon.
   * `kyTrongKy` (1–3): bắt buộc khi PDF dùng dòng `Tháng mm/yyyy` thay vì `Kỳ n - mm/yyyy` — lấy từ tên file `_ky{n}_` hoặc API TraCuu.
   */
  npc?: { npcIdHdon: string; kyTrongKy?: 1 | 2 | 3; npcPdfKind?: NpcPdfKind };
  /**
   * Không dùng kèm `npc`. Parse nội dung giống NPC (thông báo / GTGT) nhưng ghi `provider: EVN_HANOI` và `billKey` hanoi:*.
   */
  hanoi?: { idHdon: string; kyTrongKy?: 1 | 2 | 3; pdfKind: HanoiPdfKind };
}

function applyHanoiBillOverrides(
  bill: ElectricityBill,
  hanoi: { idHdon: string; pdfKind: HanoiPdfKind },
): void {
  bill.billKey = hanoiBillKey(hanoi.idHdon, hanoi.pdfKind);
  bill.provider = "EVN_HANOI";
  bill.hanoiIdHdon = hanoi.idHdon;
  bill.hanoiPdfKind = hanoi.pdfKind;
  delete bill.npcIdHdon;
  delete bill.npcPdfKind;
}

export async function parseElectricityBillPdf(
  pdfPath: string,
  invoiceId: number,
  maKhachHang: string,
  maDonViQuanLy: string,
  meta: { maSogcs: string; kyHieu: string; soSery: string; ngayPhatHanh: Date },
  options?: ParseElectricityBillPdfOptions,
): Promise<ParseResult> {
  let rawText: string;

  if (options?.npc && options?.hanoi) {
    return { success: false, error: "npc và hanoi không được dùng cùng lúc trong parseElectricityBillPdf" };
  }

  try {
    const buffer = await readFile(pdfPath);
    rawText = await extractPdfText(buffer);
  } catch (err) {
    return {
      success: false,
      error: `Đọc PDF thất bại: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const npcOpt =
    options?.npc ??
    (options?.hanoi
      ? {
          npcIdHdon: options.hanoi.idHdon,
          kyTrongKy: options.hanoi.kyTrongKy ?? 1,
          npcPdfKind: (options.hanoi.pdfKind === "gtgt" ? "thanh_toan" : "thong_bao") as NpcPdfKind,
        }
      : undefined);

  try {
    const bill = extractFields(rawText, pdfPath, invoiceId, maKhachHang, maDonViQuanLy, meta, npcOpt);
    if (options?.hanoi) {
      applyHanoiBillOverrides(bill, options.hanoi);
    }
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
  npc?: { npcIdHdon: string; kyTrongKy?: 1 | 2 | 3; npcPdfKind?: NpcPdfKind },
): ElectricityBill {
  const now = new Date();
  const provider: ElectricityProvider = npc ? "EVN_NPC" : "EVN_CPC";
  const npcKind: NpcPdfKind = npc?.npcPdfKind ?? "thong_bao";
  const billKey = npc ? npcBillKey(npc.npcIdHdon, npcKind) : `cpc:${invoiceId}`;

  /** Hóa đơn thanh toán (GTGT) — không có "Kỳ hóa đơn" như PDF thông báo tiền điện. */
  if (npc?.npcPdfKind === "thanh_toan" && /HÓA ĐƠN GIÁ TRỊ GIA TĂNG/i.test(text)) {
    return extractFieldsNpcVatPayment(text, pdfPath, invoiceId, maKhachHang, maDonViQuanLy, meta, npc, now, billKey, provider, npcKind);
  }

  // ── Kỳ hóa đơn ────────────────────────────────────────────────────────────
  const kyMatch = text.match(RE.kyHoaDon);
  const kyThangMatch = text.match(RE.kyHoaDonThang);
  let kyBill: { ky: 1 | 2 | 3; thang: number; nam: number; ngayBatDau: Date; ngayKetThuc: Date; soDays: number };

  if (kyMatch) {
    const [, kyStr, thangStr, namStr, soDaysStr, ngayBDStr, ngayKTStr] = kyMatch;
    kyBill = {
      ky: parseInt(kyStr!, 10) as 1 | 2 | 3,
      thang: parseInt(thangStr!, 10),
      nam: parseInt(namStr!, 10),
      ngayBatDau: parseVnDate(ngayBDStr!),
      ngayKetThuc: parseVnDate(ngayKTStr!),
      soDays: parseInt(soDaysStr!, 10),
    };
  } else if (kyThangMatch) {
    const [, thangStr, namStr, soDaysStr, ngayBDStr, ngayKTStr] = kyThangMatch;
    const k = npc?.kyTrongKy ?? 1;
    if (k < 1 || k > 3) throw new Error("kyTrongKy phải là 1, 2 hoặc 3 (NPC PDF dạng Tháng/mm/yyyy)");
    kyBill = {
      ky: k,
      thang: parseInt(thangStr!, 10),
      nam: parseInt(namStr!, 10),
      ngayBatDau: parseVnDate(ngayBDStr!),
      ngayKetThuc: parseVnDate(ngayKTStr!),
      soDays: parseInt(soDaysStr!, 10),
    };
  } else {
    throw new Error('Không tìm thấy "Kỳ hóa đơn" trong PDF');
  }

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
  const ngayKy = ngayKyMatch
    ? parseVnDate(`${ngayKyMatch[1]}/${ngayKyMatch[2]}/${ngayKyMatch[3]}`)
    : meta.ngayPhatHanh;
  const nguoiKy = nguoiKyMatch
    ? nguoiKyMatch[1]!.trim().replace(/\s+/g, " ")
    : donViDien.ten;

  return {
    billKey,
    provider,
    npcIdHdon: npc?.npcIdHdon,
    ...(npc ? { npcPdfKind: npcKind } : {}),
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

/**
 * PDF hóa đơn thanh toán điện (GTGT) từ NPC — bố cục "HÓA ĐƠN GIÁ TRỊ GIA TĂNG", không có block "Kỳ hóa đơn" / khung giờ như thông báo tiền điện.
 */
function extractFieldsNpcVatPayment(
  text: string,
  pdfPath: string,
  invoiceId: number,
  maKhachHang: string,
  maDonViQuanLy: string,
  meta: { maSogcs: string; kyHieu: string; soSery: string; ngayPhatHanh: Date },
  npc: { npcIdHdon: string; kyTrongKy?: 1 | 2 | 3; npcPdfKind?: NpcPdfKind },
  now: Date,
  billKey: string,
  provider: ElectricityProvider,
  npcKind: NpcPdfKind,
): ElectricityBill {
  const kyTrongKy = (npc.kyTrongKy ?? 1) as 1 | 2 | 3;

  const periodM = text.match(
    /Điện tiêu thụ tháng\s+(\d+)\s+năm\s+(\d{4})\s+từ\s+ngày\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+đến\s+ngày\s*(\d{1,2}\/\d{1,2}\/\d{4})/,
  );
  if (!periodM) {
    throw new Error(
      'PDF GTGT NPC: không tìm thấy dòng "Điện tiêu thụ tháng … năm … từ ngày … đến ngày …" — kiểm tra mẫu HĐ.',
    );
  }
  const thang = parseInt(periodM[1]!, 10);
  const nam = parseInt(periodM[2]!, 10);
  const ngayBatDau = parseVnDate(periodM[3]!);
  const ngayKetThuc = parseVnDate(periodM[4]!);
  const soDays = Math.max(
    1,
    Math.floor((ngayKetThuc.getTime() - ngayBatDau.getTime()) / 86_400_000) + 1,
  );

  const kyBill = {
    ky: kyTrongKy,
    thang,
    nam,
    ngayBatDau,
    ngayKetThuc,
    soDays,
  };

  const mstSeller = text.match(/Mã số thuế \(Tax Code\):\s*([\d\-]+)/);
  const tenSeller = text.match(/^(CÔNG TY ĐIỆN LỰC[^\n]+)/m);
  const diaChiSeller = text.match(/Địa chỉ \(Address\):\s*([^\n]+)/);

  const serialM = text.match(/Ký hiệu \(Serial\):\s*(\S+)/);
  const soHoaDonNo = text.match(/Số \(No\):\s*(\d+)/);
  const ngayPhatHanhM = text.match(
    /Ngày \(Date\)\s+(\d{2})\s+tháng \(month\)\s+(\d{2})\s+năm \(year\)\s+(\d{4})/,
  );
  const ngayPhatHanh = ngayPhatHanhM
    ? parseVnDate(`${ngayPhatHanhM[1]}/${ngayPhatHanhM[2]}/${ngayPhatHanhM[3]}`)
    : meta.ngayPhatHanh;

  const tenMua = text.match(/Tên đơn vị \(Company name\):\s*([^\n]+)/);
  let diaChiBuyer = "";
  const idxMaKh = text.indexOf("Mã khách hàng (Customer's Code):");
  if (idxMaKh > 0) {
    const before = text.slice(0, idxMaKh);
    const addrs = [...before.matchAll(/Địa chỉ \(Address\):\s*([^\n]+)/g)];
    const last = addrs[addrs.length - 1];
    if (last?.[1]) diaChiBuyer = last[1].trim();
  }

  const mstBuyer = text.match(/Mã số thuế \(Tax code\):\s*([\d\s]+)/);

  const donViDien = {
    ten: (tenSeller?.[1] ?? "CÔNG TY ĐIỆN LỰC").replace(/\s+/g, " ").trim(),
    tenDienLuc: "",
    diaChi: diaChiSeller?.[1]?.trim() ?? "",
    maSoThue: mstSeller?.[1]?.trim() ?? "",
    soTaiKhoan: "",
    nganHang: "",
    dienThoai: text.match(/Điện thoại \(Phone Number\):\s*([\d\s]+)/)?.[1]?.trim() ?? "",
  };

  const khachHang = {
    ten: tenMua?.[1]?.trim() ?? maKhachHang,
    diaChi: diaChiBuyer,
    dienThoai: "",
    email: "",
    maSoThue: mstBuyer?.[1]?.replace(/\s+/g, "").trim() ?? "",
    diaChiSuDungDien: "",
    mucDichSuDung: [] as string[],
    capDienAp: "",
  };

  const zr = (): MeterReading => ({ chiSoMoi: 0, chiSoCu: 0, tieuThu: 0 });
  const zp = (): TimeFramePricing => ({ donGia: 0, sanLuong: 0, thanhTien: 0 });
  const chiSoDien: ThreeFrames<MeterReading> = { binhThuong: zr(), caoDiem: zr(), thapDiem: zr() };
  const giaDien: ThreeFrames<TimeFramePricing> = { binhThuong: zp(), caoDiem: zp(), thapDiem: zp() };

  const kwhM = text.match(/\s+kWh\s+([\d.]+)\s+\S+\s+([\d.]+)/);
  const kwhTieuThu = kwhM ? parseVnInt(kwhM[1]!) : 0;

  const tienHangM = text.match(/Cộng tiền hàng\s*\([^)]*\)\s*:?\s*([\d.]+)/);
  const tienThueM = text.match(/Tiền thuế GTGT\s*\([^)]*\)\s*:?\s*([\d.]+)/);
  const thueSuatM = text.match(/Thuế suất GTGT\s*\([^)]*\)\s*:\s*(\d+)%/);
  const tongTTM = text.match(/Tổng cộng tiền thanh toán[\s\S]{0,120}?:\s*([\d.]+)/);
  const bangChuM = text.match(/Số tiền bằng chữ\s*\([^)]*\)\s*:\s*(.+?)(?:\nNgười mua|\nĐược ký|$)/s);

  if (!tongTTM?.[1]) {
    throw new Error("PDF GTGT NPC: không tìm thấy Tổng cộng tiền thanh toán");
  }

  const tongKet = {
    tongDienNangTieuThu: kwhTieuThu,
    tongTienDienChuaThue: tienHangM ? parseVnInt(tienHangM[1]!) : 0,
    thueSuatGTGT: thueSuatM ? parseInt(thueSuatM[1]!, 10) : 0,
    tienThueGTGT: tienThueM ? parseVnInt(tienThueM[1]!) : 0,
    tongTienThanhToan: parseVnInt(tongTTM[1]!),
    bangChu: bangChuM?.[1]?.replace(/\s+/g, " ").trim() ?? "",
  };

  const ngayKyMatch = text.match(RE.ngayKy);
  const ngayKy = ngayKyMatch
    ? parseVnDate(`${ngayKyMatch[1]}/${ngayKyMatch[2]}/${ngayKyMatch[3]}`)
    : ngayPhatHanh;
  const nguoiKyMatch = text.match(/Được ký bởi:\s*((?:[^\n]|\n(?!Ngày ký))+)/);
  const nguoiKy = nguoiKyMatch
    ? nguoiKyMatch[1]!.replace(/\s+/g, " ").replace(/–/g, "-").trim()
    : donViDien.ten;

  const hanM = text.match(/Hạn thanh toán\s*\n?\s*(\d{2}\/\d{2}\/\d{4})/);
  const hanThanhToan = hanM ? parseVnDate(hanM[1]!) : ngayPhatHanh;

  return {
    billKey,
    provider,
    npcIdHdon: npc.npcIdHdon,
    npcPdfKind: npcKind,
    invoiceId,
    maKhachHang,
    maDonViQuanLy,
    kyBill,
    donViDien,
    khachHang,
    congTo: { soHieu: "", heSoNhan: 1 },
    chiSoDien,
    giaDien,
    tongKet,
    hanThanhToan,
    /** HĐ GTGT: ký hiệu / số trên mẫu VAT — không trùng nghĩa với MA_SOGCS CPC. */
    soHoaDon: {
      maSogcs: "",
      kyHieu: serialM?.[1]?.trim() ?? meta.kyHieu,
      soSery: soHoaDonNo?.[1]?.trim() ?? meta.soSery,
      ngayPhatHanh,
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
