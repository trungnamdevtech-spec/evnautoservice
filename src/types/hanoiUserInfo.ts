/**
 * Snapshot từ GET https://apicskh.evnhanoi.vn/connect/userinfo
 * Dùng làm tham số các API tra cứu tiếp theo (maDvql, maKhachHang, keyUser, …).
 */
export interface HanoiUserInfoSnapshot {
  sub?: string;
  maDvql?: string;
  maKhachHang?: string;
  keyUser?: string;
  profile?: string;
  name?: string;
  preferredUsername?: string;
  phoneNumber?: string;
  lastLogin?: string;
  role?: string[];
  /** Claim `AspNet.Identity.SecurityStamp` từ STS */
  securityStamp?: string;
}
