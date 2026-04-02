import type { ObjectId } from "mongodb";
import type { HanoiUserInfoSnapshot } from "./hanoiUserInfo.js";

/** Tài khoản đăng nhập CSKH EVN Hà Nội (mật khẩu lưu đã mã hóa). */
export interface HanoiAccount {
  _id?: ObjectId;
  /** Tên đăng nhập / mã khách hàng — duy nhất */
  username: string;
  /** Chuỗi base64 AES-256-GCM (xem hanoiCredentials) */
  passwordEncrypted: string;
  enabled: boolean;
  /** Lý do tắt tự động (vd. wrong_password) — có thể xóa khi sửa mật khẩu + bật lại */
  disabledReason?: string | null;
  lastAuthFailureAt?: Date;
  /** Cookie/storageState JSON (chuỗi) sau đăng nhập thành công (Playwright fallback) */
  storageStateJson?: string | null;
  /**
   * Bearer access_token từ `POST .../connect/token` (mã hóa AES-256-GCM, cùng HANOI_CREDENTIALS_SECRET).
   * Dùng khi HANOI_USE_API_LOGIN=true — không cần Chromium.
   */
  apiAccessTokenEncrypted?: string | null;
  /** Thời điểm access_token hết hạn (UTC). */
  apiTokenExpiresAt?: Date | null;
  /**
   * Thông tin user từ GET /connect/userinfo — phục vụ tham số tra cứu (maDvql, maKhachHang, …).
   */
  userInfo?: HanoiUserInfoSnapshot | null;
  /** Lần gọi userinfo gần nhất (UTC). */
  userInfoFetchedAt?: Date | null;
  /** Lần đồng bộ GET GetDanhSachHopDongByUserName → `hanoi_contracts`. */
  hopDongFetchedAt?: Date | null;
  lastLoginAt?: Date;
  label?: string;
  createdAt: Date;
  updatedAt: Date;
}
