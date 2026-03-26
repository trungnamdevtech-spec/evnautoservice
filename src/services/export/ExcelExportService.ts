import ExcelJS from "exceljs";
import type { ElectricityBill } from "../../types/electricityBill.js";

// ─── Màu sắc & style ────────────────────────────────────────────────────────
const COLOR = {
  headerBg: "FF1B5E9E",       // xanh đậm
  headerFg: "FFFFFFFF",       // trắng
  subHeaderBg: "FFD6E4F0",    // xanh nhạt
  subHeaderFg: "FF1B3A5C",
  altRow: "FFF5F9FF",         // xanh nhạt xen kẽ
  white: "FFFFFFFF",
  borderColor: "FFBDD7EE",
  totalBg: "FFE2EFDA",        // xanh lá nhạt — hàng tổng
  warningBg: "FFFFF2CC",      // vàng — sắp đến hạn
  overdueB: "FFFCE4EC",       // đỏ nhạt — quá hạn
};

function fmtDate(d: Date | undefined | null): string {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString("vi-VN"); // dd/mm/yyyy
}

function fmtNumber(n: number | undefined | null): number {
  return n ?? 0;
}

/** Áp dụng border mỏng cho cell */
function thinBorder(): Partial<ExcelJS.Border> {
  return { style: "thin", color: { argb: COLOR.borderColor } };
}

function applyBorder(cell: ExcelJS.Cell): void {
  cell.border = { top: thinBorder(), left: thinBorder(), bottom: thinBorder(), right: thinBorder() };
}

/** Header cell đậm */
function headerCell(cell: ExcelJS.Cell, text: string, bgColor = COLOR.headerBg): void {
  cell.value = text;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
  cell.font = { bold: true, color: { argb: bgColor === COLOR.headerBg ? COLOR.headerFg : COLOR.subHeaderFg }, size: 10 };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  applyBorder(cell);
}

// ─── COLUMNS DEFINITION ──────────────────────────────────────────────────────

interface ColDef {
  header: string;
  width: number;
  key: string;
}

const BILL_COLUMNS: ColDef[] = [
  { header: "Mã khách hàng",          width: 20, key: "maKhachHang" },
  { header: "Tên khách hàng",          width: 38, key: "tenKhachHang" },
  { header: "Địa chỉ dùng điện",       width: 40, key: "diaChiSuDung" },
  { header: "Đơn vị điện lực",         width: 28, key: "donViDien" },
  { header: "Kỳ",                      width: 5,  key: "ky" },
  { header: "Tháng",                   width: 7,  key: "thang" },
  { header: "Năm",                     width: 7,  key: "nam" },
  { header: "Từ ngày",                 width: 12, key: "ngayBD" },
  { header: "Đến ngày",                width: 12, key: "ngayKT" },
  { header: "Số công tơ",              width: 14, key: "soCongTo" },
  { header: "Hệ số nhân",              width: 10, key: "heSoNhan" },
  { header: "BT - Chỉ số mới",         width: 14, key: "btMoi" },
  { header: "BT - Chỉ số cũ",          width: 14, key: "btCu" },
  { header: "BT - Điện TT (kWh)",      width: 16, key: "btKwh" },
  { header: "CĐ - Chỉ số mới",         width: 14, key: "cdMoi" },
  { header: "CĐ - Chỉ số cũ",          width: 14, key: "cdCu" },
  { header: "CĐ - Điện TT (kWh)",      width: 16, key: "cdKwh" },
  { header: "TĐ - Chỉ số mới",         width: 14, key: "tdMoi" },
  { header: "TĐ - Chỉ số cũ",          width: 14, key: "tdCu" },
  { header: "TĐ - Điện TT (kWh)",      width: 16, key: "tdKwh" },
  { header: "Tổng tiêu thụ (kWh)",     width: 18, key: "tongKwh" },
  { header: "ĐG Bình thường (đ/kWh)",  width: 20, key: "dgBT" },
  { header: "ĐG Cao điểm (đ/kWh)",     width: 18, key: "dgCD" },
  { header: "ĐG Thấp điểm (đ/kWh)",   width: 18, key: "dgTD" },
  { header: "T.Tiền BT (đ)",           width: 18, key: "ttBT" },
  { header: "T.Tiền CĐ (đ)",           width: 18, key: "ttCD" },
  { header: "T.Tiền TĐ (đ)",           width: 18, key: "ttTD" },
  { header: "Tổng chưa thuế (đ)",      width: 20, key: "tongChuaThue" },
  { header: "Thuế GTGT (%)",           width: 13, key: "thueSuat" },
  { header: "Tiền thuế (đ)",           width: 16, key: "tienThue" },
  { header: "TỔNG THANH TOÁN (đ)",     width: 22, key: "tongTT" },
  { header: "Hạn thanh toán",          width: 16, key: "hanTT" },
  { header: "Số seri HĐ",              width: 14, key: "soSeri" },
  { header: "Ký hiệu HĐ",             width: 14, key: "kyHieu" },
  { header: "Ngày phát hành",          width: 16, key: "ngayPH" },
  { header: "Ngày ký",                 width: 14, key: "ngayKy" },
];

function billToRow(b: ElectricityBill): Record<string, string | number | Date> {
  return {
    maKhachHang:  b.maKhachHang,
    tenKhachHang: b.khachHang.ten,
    diaChiSuDung: b.khachHang.diaChiSuDungDien,
    donViDien:    `${b.donViDien.ten} — ${b.donViDien.tenDienLuc}`,
    ky:           b.kyBill.ky,
    thang:        b.kyBill.thang,
    nam:          b.kyBill.nam,
    ngayBD:       fmtDate(b.kyBill.ngayBatDau),
    ngayKT:       fmtDate(b.kyBill.ngayKetThuc),
    soCongTo:     b.congTo.soHieu,
    heSoNhan:     b.congTo.heSoNhan,
    btMoi:        b.chiSoDien.binhThuong.chiSoMoi,
    btCu:         b.chiSoDien.binhThuong.chiSoCu,
    btKwh:        fmtNumber(b.chiSoDien.binhThuong.tieuThu),
    cdMoi:        b.chiSoDien.caoDiem.chiSoMoi,
    cdCu:         b.chiSoDien.caoDiem.chiSoCu,
    cdKwh:        fmtNumber(b.chiSoDien.caoDiem.tieuThu),
    tdMoi:        b.chiSoDien.thapDiem.chiSoMoi,
    tdCu:         b.chiSoDien.thapDiem.chiSoCu,
    tdKwh:        fmtNumber(b.chiSoDien.thapDiem.tieuThu),
    tongKwh:      fmtNumber(b.tongKet.tongDienNangTieuThu),
    dgBT:         b.giaDien.binhThuong.donGia,
    dgCD:         b.giaDien.caoDiem.donGia,
    dgTD:         b.giaDien.thapDiem.donGia,
    ttBT:         fmtNumber(b.giaDien.binhThuong.thanhTien),
    ttCD:         fmtNumber(b.giaDien.caoDiem.thanhTien),
    ttTD:         fmtNumber(b.giaDien.thapDiem.thanhTien),
    tongChuaThue: fmtNumber(b.tongKet.tongTienDienChuaThue),
    thueSuat:     b.tongKet.thueSuatGTGT,
    tienThue:     fmtNumber(b.tongKet.tienThueGTGT),
    tongTT:       fmtNumber(b.tongKet.tongTienThanhToan),
    hanTT:        fmtDate(b.hanThanhToan),
    soSeri:       b.soHoaDon.soSery,
    kyHieu:       b.soHoaDon.kyHieu,
    ngayPH:       fmtDate(b.soHoaDon.ngayPhatHanh),
    ngayKy:       fmtDate(b.soHoaDon.ngayKy),
  };
}

// ─── Chỉ số số tiền — tô màu theo trạng thái hạn TT ──────────────────────────
function rowBgColor(bill: ElectricityBill, rowIdx: number): string | null {
  const now = new Date();
  const han = new Date(bill.hanThanhToan);
  if (han < now) return COLOR.overdueB;
  const soon = new Date(now.getTime() + 3 * 86_400_000);
  if (han <= soon) return COLOR.warningBg;
  return rowIdx % 2 === 0 ? COLOR.altRow : COLOR.white;
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

export class ExcelExportService {
  /**
   * Xuất Excel danh sách hóa đơn theo kỳ/tháng/năm.
   * Trả về Buffer để stream qua HTTP response.
   */
  async exportByPeriod(
    bills: ElectricityBill[],
    opts: { ky?: 1 | 2 | 3; thang: number; nam: number },
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = "EVN AutoCheck System";
    wb.created = new Date();

    const title = opts.ky
      ? `Kỳ ${opts.ky} Tháng ${opts.thang} Năm ${opts.nam}`
      : `Tháng ${opts.thang} Năm ${opts.nam} (Tất cả kỳ)`;

    const ws = wb.addWorksheet(title, {
      views: [{ state: "frozen", xSplit: 1, ySplit: 3 }], // freeze cột mã KH + 2 header rows
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
    });

    // ── Header 1: tiêu đề tổng ────────────────────────────────────────────
    ws.mergeCells(1, 1, 1, BILL_COLUMNS.length);
    const titleCell = ws.getCell(1, 1);
    titleCell.value = `DANH SÁCH HÓA ĐƠN TIỀN ĐIỆN — ${title.toUpperCase()}`;
    titleCell.font = { bold: true, size: 13, color: { argb: COLOR.headerFg } };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.headerBg } };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(1).height = 28;

    // ── Header 2: meta info ────────────────────────────────────────────────
    ws.mergeCells(2, 1, 2, BILL_COLUMNS.length);
    const metaCell = ws.getCell(2, 1);
    metaCell.value = `Xuất ngày: ${fmtDate(new Date())}   |   Tổng số hóa đơn: ${bills.length}   |   Tổng tiền: ${bills.reduce((s, b) => s + b.tongKet.tongTienThanhToan, 0).toLocaleString("vi-VN")} đồng`;
    metaCell.font = { italic: true, size: 10, color: { argb: COLOR.subHeaderFg } };
    metaCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.subHeaderBg } };
    metaCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(2).height = 20;

    // ── Header 3: column headers ───────────────────────────────────────────
    ws.columns = BILL_COLUMNS.map((c) => ({ key: c.key, width: c.width }));
    BILL_COLUMNS.forEach((col, i) => {
      headerCell(ws.getCell(3, i + 1), col.header);
    });
    ws.getRow(3).height = 36;

    // ── Data rows ─────────────────────────────────────────────────────────
    bills.forEach((bill, idx) => {
      const rowData = billToRow(bill);
      const row = ws.addRow(rowData);
      const bg = rowBgColor(bill, idx);

      row.eachCell((cell, colNum) => {
        applyBorder(cell);
        if (bg) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
        }
        cell.font = { size: 9 };
        cell.alignment = { vertical: "middle" };

        // Căn phải các cột số tiền / kWh (col index 14, 17, 20–32)
        const key = BILL_COLUMNS[colNum - 1]?.key ?? "";
        if (
          ["btKwh","cdKwh","tdKwh","tongKwh","dgBT","dgCD","dgTD",
           "ttBT","ttCD","ttTD","tongChuaThue","thueSuat","tienThue","tongTT"].includes(key)
        ) {
          cell.alignment = { ...cell.alignment, horizontal: "right" };
          if (typeof cell.value === "number") {
            cell.numFmt = key.includes("Kwh") || key === "tongKwh" ? "#,##0" : "#,##0";
          }
        }

        // In đậm cột tổng tiền
        if (key === "tongTT") {
          cell.font = { ...cell.font, bold: true };
        }
      });

      row.height = 18;
    });

    // ── Hàng tổng cộng ────────────────────────────────────────────────────
    if (bills.length > 0) {
      const totalRow = ws.addRow({
        maKhachHang: `TỔNG CỘNG (${bills.length} hóa đơn)`,
        tongKwh: bills.reduce((s, b) => s + b.tongKet.tongDienNangTieuThu, 0),
        tongChuaThue: bills.reduce((s, b) => s + b.tongKet.tongTienDienChuaThue, 0),
        tienThue: bills.reduce((s, b) => s + b.tongKet.tienThueGTGT, 0),
        tongTT: bills.reduce((s, b) => s + b.tongKet.tongTienThanhToan, 0),
      });
      totalRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.totalBg } };
        cell.font = { bold: true, size: 10 };
        cell.border = { top: { style: "medium" }, bottom: { style: "medium" }, left: thinBorder(), right: thinBorder() };
        cell.alignment = { vertical: "middle" };
      });
      totalRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
      totalRow.height = 20;
    }

    // ── Freeze + auto-filter ───────────────────────────────────────────────
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: BILL_COLUMNS.length } };

    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  }

  /**
   * Xuất Excel lịch sử hóa đơn của 1 khách hàng.
   */
  async exportByCustomer(bills: ElectricityBill[], maKhachHang: string): Promise<Buffer> {
    const tenKH = bills[0]?.khachHang.ten ?? maKhachHang;
    const wb = new ExcelJS.Workbook();
    wb.creator = "EVN AutoCheck System";
    wb.created = new Date();

    const ws = wb.addWorksheet(`KH_${maKhachHang}`, {
      views: [{ state: "frozen", xSplit: 1, ySplit: 3 }],
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
    });

    // Header
    ws.mergeCells(1, 1, 1, BILL_COLUMNS.length);
    const titleCell = ws.getCell(1, 1);
    titleCell.value = `LỊCH SỬ HÓA ĐƠN TIỀN ĐIỆN — ${maKhachHang.toUpperCase()} — ${tenKH.toUpperCase()}`;
    titleCell.font = { bold: true, size: 13, color: { argb: COLOR.headerFg } };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.headerBg } };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(1).height = 28;

    ws.mergeCells(2, 1, 2, BILL_COLUMNS.length);
    const metaCell = ws.getCell(2, 1);
    const tongTien = bills.reduce((s, b) => s + b.tongKet.tongTienThanhToan, 0);
    metaCell.value = `Xuất ngày: ${fmtDate(new Date())}   |   Tổng ${bills.length} kỳ hóa đơn   |   Tổng tiền: ${tongTien.toLocaleString("vi-VN")} đồng`;
    metaCell.font = { italic: true, size: 10, color: { argb: COLOR.subHeaderFg } };
    metaCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.subHeaderBg } };
    metaCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(2).height = 20;

    ws.columns = BILL_COLUMNS.map((c) => ({ key: c.key, width: c.width }));
    BILL_COLUMNS.forEach((col, i) => {
      headerCell(ws.getCell(3, i + 1), col.header);
    });
    ws.getRow(3).height = 36;

    bills.forEach((bill, idx) => {
      const row = ws.addRow(billToRow(bill));
      const bg = idx % 2 === 0 ? COLOR.altRow : COLOR.white;
      row.eachCell((cell) => {
        applyBorder(cell);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
        cell.font = { size: 9 };
        cell.alignment = { vertical: "middle" };
      });
      row.height = 18;
    });

    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: BILL_COLUMNS.length } };

    return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
  }
}
