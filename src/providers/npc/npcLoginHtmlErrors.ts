/**
 * CSKH NPC trả lỗi SSR trong HTML (redirect về form).
 * Sai mật khẩu — ví dụ:
 *   <div class="uk-margin-small"><p style="color:red">Tài khoản/mật khẩu không chính xác</p></div>
 * Sai captcha:
 *   <div class="uk-margin-small"><p style="color:red">Mã xác thực không chính xác</p></div>
 *
 * Phát hiện theo chuỗi nội dung (ổn định khi site giữ nguyên copy).
 */
export type NpcSsrFormErrorKind = "wrong_password" | "wrong_captcha";

const MSG_WRONG_PASSWORD = "Tài khoản/mật khẩu không chính xác";
const MSG_WRONG_CAPTCHA = "Mã xác thực không chính xác";

export function detectNpcSsrErrorKindFromHtml(html: string): NpcSsrFormErrorKind | null {
  if (!html || html.length < 40) return null;
  if (html.includes(MSG_WRONG_PASSWORD)) return "wrong_password";
  if (html.includes(MSG_WRONG_CAPTCHA)) return "wrong_captcha";
  return null;
}
