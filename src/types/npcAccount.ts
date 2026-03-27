import type { ObjectId } from "mongodb";

/** Tài khoản đăng nhập CSKH NPC (mật khẩu lưu đã mã hóa). */
export interface NpcAccount {
  _id?: ObjectId;
  /** Mã KH / tên đăng nhập — duy nhất */
  username: string;
  /** Chuỗi base64 AES-256-GCM (xem npcCredentials) */
  passwordEncrypted: string;
  enabled: boolean;
  /** Lý do tắt tự động (vd. wrong_password) — có thể xóa khi sửa mật khẩu + bật lại */
  disabledReason?: string | null;
  lastAuthFailureAt?: Date;
  /** Cookie/storageState JSON (chuỗi) sau đăng nhập thành công */
  storageStateJson?: string | null;
  lastLoginAt?: Date;
  label?: string;
  createdAt: Date;
  updatedAt: Date;
}
