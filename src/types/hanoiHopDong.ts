import type { ObjectId } from "mongodb";

/**
 * Phản hồi GET `/api/TraCuu/GetDanhSachHopDongByUserName`.
 * Thực tế: `data: { thongTinHopDongDtos: ThongTinHopDongDto[] }` — xem `extractHopDongRowsFromResponse`.
 */
export interface HanoiGetDanhSachHopDongResponse {
  isError?: boolean;
  message?: string | null;
  data?: HanoiGetDanhSachHopDongData | unknown;
  code?: number;
  errors?: unknown;
}

/** Wrapper `data` từ API EVN Hà Nội. */
export interface HanoiGetDanhSachHopDongData {
  thongTinHopDongDtos?: ThongTinHopDongDto[];
}

/**
 * Một phần tử trong `thongTinHopDongDtos` (khớp JSON thực tế — field có thể bổ sung sau).
 * Bản ghi đầy đủ vẫn lưu trong `HanoiContract.raw`.
 */
export interface ThongTinHopDongDto {
  id?: string;
  userNameOld?: string;
  userId?: string;
  maKhachHang?: string;
  maDonViQuanLy?: string;
  tenKhachHang?: string;
  soHopDong?: string;
  dienThoai?: string;
  email?: string;
  maSoThue?: string;
  diaChiDungDien?: string;
  mucDichSuDungDien?: string;
  soHoSuDungDien?: number;
  loaiKhachHang?: number;
  isHopDongChinhChu?: boolean;
  isMacDinh?: boolean;
  trangThaiHopDong?: number;
  dienThoaiNhanTin?: string;
  namSinh?: string | null;
  soCmt?: string;
}

/**
 * Các field thường dùng để lọc / hiển thị — trích từ một dòng API (`normalizeHopDongRow`).
 * Mọi field khác vẫn nằm trong `HanoiContract.raw`.
 */
export interface HanoiContractNormalized {
  /** Id dòng hợp đồng (API) */
  id?: string;
  /** Đơn vị quản lý — alias `maDvql` / `maDonViQuanLy` */
  maDvql?: string;
  tenKhachHang?: string;
  /** Địa chỉ — gộp `diaChi`, `diaChiDungDien`, … */
  diaChi?: string;
  maSoGCS?: string;
  soHopDong?: string;
  dienThoai?: string;
  email?: string;
  maSoThue?: string;
  mucDichSuDungDien?: string;
  soHoSuDungDien?: number;
  loaiKhachHang?: number;
  isHopDongChinhChu?: boolean;
  isMacDinh?: boolean;
  trangThaiHopDong?: number;
  dienThoaiNhanTin?: string;
  namSinh?: string;
  soCmt?: string;
  userNameOld?: string;
  userId?: string;
}

/** Bản ghi MongoDB `hanoi_contracts`. */
export interface HanoiContract {
  _id?: ObjectId;
  hanoiAccountId: ObjectId;
  /** Denormalize — username đăng nhập (trùng hanoi_accounts.username) */
  hanoiUsername: string;
  /** Mã khách hàng — chuẩn hóa UPPERCASE, khóa tra cứu agent */
  maKhachHang: string;
  normalized: HanoiContractNormalized;
  /** Toàn bộ object một dòng từ `GetDanhSachHopDongByUserName` — không bỏ field (trừ khi API không gửi). */
  raw: Record<string, unknown>;
  fetchedAt: Date;
  updatedAt: Date;
}
