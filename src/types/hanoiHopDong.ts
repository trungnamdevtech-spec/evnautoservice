import type { ObjectId } from "mongodb";

/**
 * Phản hồi GET `/api/TraCuu/GetDanhSachHopDongByUserName` — cấu trúc `data` có thể đổi;
 * dùng `extractHopDongRowsFromResponse` để lấy mảng dòng.
 */
export interface HanoiGetDanhSachHopDongResponse {
  isError?: boolean;
  message?: string | null;
  data?: unknown;
  code?: number;
  errors?: unknown;
}

/**
 * Một hợp đồng / mã KH trong danh sách — lưu `raw` đầy đủ + field tách để index/lọc.
 */
export interface HanoiContractNormalized {
  maDvql?: string;
  /** Tên hiển thị (alias theo API) */
  tenKhachHang?: string;
  diaChi?: string;
  maSoGCS?: string;
  soHopDong?: string;
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
  /** Toàn bộ object một dòng từ API */
  raw: Record<string, unknown>;
  fetchedAt: Date;
  updatedAt: Date;
}
