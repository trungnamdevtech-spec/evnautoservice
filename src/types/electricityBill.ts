import type { ObjectId } from "mongodb";

// ─── Sub-types ────────────────────────────────────────────────────────────────

/** Chỉ số & điện tiêu thụ của một khung giờ */
export interface MeterReading {
  chiSoMoi: number;   // Chỉ số mới (cuối kỳ)
  chiSoCu: number;    // Chỉ số cũ  (đầu kỳ)
  tieuThu: number;    // Điện tiêu thụ (kWh) = (chiSoMoi - chiSoCu) × heSoNhan
}

/** Giá và sản lượng của một khung giờ */
export interface TimeFramePricing {
  donGia: number;     // Đơn giá (đồng/kWh)
  sanLuong: number;   // Sản lượng (kWh)
  thanhTien: number;  // Thành tiền (đồng)
}

/** Ba khung giờ: bình thường / cao điểm / thấp điểm */
export interface ThreeFrames<T> {
  binhThuong: T;
  caoDiem: T;
  thapDiem: T;
}

// ─── Main type ────────────────────────────────────────────────────────────────

/**
 * Toàn bộ thông tin được trích xuất từ file PDF thông báo tiền điện CPC.
 * Lưu vào collection `electricity_bills`, unique theo `invoiceId` (= ID_HDON).
 *
 * Indexes:
 *   - invoiceId              (unique)
 *   - maKhachHang + ky + thang + nam
 *   - hanThanhToan
 *   - maDonViQuanLy
 *   - status
 */
/** Nguồn dữ liệu: CPC (API + PDF) hoặc NPC (TraCuu + PDF base64). */
export type ElectricityProvider = "EVN_CPC" | "EVN_NPC";

export interface ElectricityBill {
  _id?: ObjectId;

  /**
   * Khóa upsert ổn định: `cpc:<ID_HDON>` hoặc `npc:<id_hdon>`.
   * Bắt buộc với bản ghi mới; bản cũ có thể chưa có (repository fallback theo invoiceId).
   */
  billKey?: string;
  /** Mặc định coi như CPC nếu thiếu (dữ liệu cũ). */
  provider?: ElectricityProvider;
  /** Chỉ NPC: id_hdon từ TraCuuHDSPC / XemChiTiet */
  npcIdHdon?: string;

  // ── Liên kết với invoice_items ─────────────────────────────────────────────
  /** ID hóa đơn — CPC: ID_HDON; NPC: surrogate (npcInvoiceIdSurrogateFromIdHdon) */
  invoiceId: number;
  /** Mã khách hàng (MA_KHANG) */
  maKhachHang: string;
  /** Mã đơn vị quản lý (MA_DVIQLY) */
  maDonViQuanLy: string;

  // ── Kỳ hóa đơn ───────────────────────────────────────────────────────────
  kyBill: {
    ky: 1 | 2 | 3;          // Kỳ 1, 2 hoặc 3 trong tháng
    thang: number;           // 1–12
    nam: number;             // e.g. 2026
    ngayBatDau: Date;        // Ngày đầu kỳ (01/03/2026)
    ngayKetThuc: Date;       // Ngày cuối kỳ (15/03/2026)
    soDays: number;          // Số ngày trong kỳ
  };

  // ── Đơn vị điện lực (snapshot khi phát hành) ─────────────────────────────
  donViDien: {
    ten: string;             // CÔNG TY ĐIỆN LỰC GIA LAI
    tenDienLuc: string;      // Điện lực Bồng Sơn
    diaChi: string;
    maSoThue: string;        // MST
    soTaiKhoan: string;
    nganHang: string;
    dienThoai: string;       // 19001909
  };

  // ── Khách hàng (snapshot khi phát hành) ──────────────────────────────────
  khachHang: {
    ten: string;
    diaChi: string;
    dienThoai: string;
    email: string;
    maSoThue: string;        // Mã số thuế khách hàng
    diaChiSuDungDien: string;
    mucDichSuDung: string[]; // ["100 % Kinh doanh Giờ bình thường", ...]
    capDienAp: string;       // "Dưới 380V"
  };

  // ── Công tơ đo đếm ───────────────────────────────────────────────────────
  congTo: {
    soHieu: string;          // Serial số công tơ
    heSoNhan: number;        // Hệ số nhân (e.g. 120)
  };

  // ── Chỉ số điện theo 3 khung giờ ─────────────────────────────────────────
  chiSoDien: ThreeFrames<MeterReading>;

  // ── Đơn giá & thành tiền theo 3 khung giờ ────────────────────────────────
  giaDien: ThreeFrames<TimeFramePricing>;

  // ── Tổng kết tài chính ───────────────────────────────────────────────────
  tongKet: {
    tongDienNangTieuThu: number;  // kWh
    tongTienDienChuaThue: number; // đồng
    thueSuatGTGT: number;         // % (thường 8 hoặc 10)
    tienThueGTGT: number;         // đồng
    tongTienThanhToan: number;    // đồng (= SO_TIEN + TIEN_GTGT)
    bangChu: string;              // Bằng chữ
  };

  // ── Thanh toán ───────────────────────────────────────────────────────────
  hanThanhToan: Date;

  // ── Tham chiếu hóa đơn điện tử ───────────────────────────────────────────
  soHoaDon: {
    maSogcs: string;         // Ký hiệu mẫu số/Số GCS (MA_SOGCS)
    kyHieu: string;          // Ký hiệu series (KIHIEU_SERY)
    soSery: string;          // Số series (SO_SERY)
    ngayPhatHanh: Date;      // Ngày phát hành (NGAY_PHANH)
    ngayKy: Date;            // Ngày ký (từ PDF)
    nguoiKy: string;         // "CÔNG TY ĐIỆN LỰC GIA LAI"
  };

  // ── Metadata hệ thống ────────────────────────────────────────────────────
  pdfPath: string;           // Đường dẫn file PDF trên disk
  /** Trạng thái parse */
  status: "parsed" | "error" | "pending";
  parseError?: string;       // Mô tả lỗi nếu status = "error"
  /** Version của parser — tăng khi logic parse thay đổi để biết cần re-parse */
  parseVersion: number;
  parsedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

/** Kết quả parse một file PDF */
export interface ParseResult {
  success: boolean;
  bill?: ElectricityBill;
  error?: string;
}
