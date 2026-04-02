export class HanoiLoginWrongCredentialsError extends Error {
  readonly isWrongCredentials = true;
  constructor(message?: string) {
    super(message ?? "EVN Hà Nội: sai tên đăng nhập hoặc mật khẩu");
    this.name = "HanoiLoginWrongCredentialsError";
  }
}

export function isHanoiLoginWrongCredentialsError(
  err: unknown,
): err is HanoiLoginWrongCredentialsError {
  return (
    err instanceof HanoiLoginWrongCredentialsError ||
    (typeof err === "object" &&
      err !== null &&
      (err as Record<string, unknown>).isWrongCredentials === true)
  );
}

/** Phân loại thông báo lỗi từ DOM sau khi submit đăng nhập. */
export function detectHanoiLoginErrorKind(
  text: string,
): "wrong_password" | "locked" | "captcha" | null {
  if (!text || text.trim().length === 0) return null;
  const t = text.toLowerCase();
  // Không dùng từ "kiểm tra" đơn lẻ — thường gặp trong "vui lòng kiểm tra lại thông tin" (không phải captcha).
  if (/captcha|mã xác nhận|mã hình|mã kiểm tra|xác minh người máy|robot/i.test(t)) return "captcha";
  if (/khóa|lock|vô hiệu|suspended|bị chặn/i.test(t)) return "locked";
  if (
    /mật khẩu|password|không đúng|không chính xác|sai|không hợp lệ|invalid|incorrect|failed/i.test(
      t,
    )
  )
    return "wrong_password";
  return null;
}
