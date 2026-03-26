import type { Response } from "playwright";

/** Phản hồi `POST .../check-exist-user` (cskh-api.cpc.vn) */
export interface CheckExistUserBody {
  isValidUser: boolean;
  isValidPassword: boolean;
  isResetPasswordTool: boolean;
  sessionState: string;
  errorMessage: string;
  isShowCaptcha: boolean;
}

export async function parseCheckExistUserResponse(res: Response): Promise<CheckExistUserBody> {
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Đăng nhập thất bại: Phản hồi API không phải JSON (HTTP ${res.status()})`);
  }
  if (!data || typeof data !== "object") {
    throw new Error("Đăng nhập thất bại: Phản hồi API không hợp lệ");
  }
  const o = data as Record<string, unknown>;
  return {
    isValidUser: o.isValidUser === true,
    isValidPassword: o.isValidPassword === true,
    isResetPasswordTool: o.isResetPasswordTool === true,
    sessionState: typeof o.sessionState === "string" ? o.sessionState : "",
    errorMessage: typeof o.errorMessage === "string" ? o.errorMessage : "",
    isShowCaptcha: o.isShowCaptcha === true,
  };
}

/**
 * Ném lỗi nếu API không cho phép đăng nhập (sai user/mật khẩu, captcha, ...).
 */
export function assertLoginApiAllowsSession(body: CheckExistUserBody): void {
  if (body.isShowCaptcha) {
    throw new Error("Đăng nhập yêu cầu captcha (chưa xử lý trong flow).");
  }
  if (!body.isValidUser) {
    const msg = body.errorMessage.trim();
    throw new Error(
      msg ? `Đăng nhập thất bại: ${msg}` : "Đăng nhập thất bại: Mã khách hàng / tên đăng nhập không đúng",
    );
  }
  if (!body.isValidPassword) {
    const msg = body.errorMessage.trim();
    throw new Error(msg ? `Đăng nhập thất bại: ${msg}` : "Đăng nhập thất bại: Sai mật khẩu");
  }
}
