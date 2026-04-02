/**
 * Selector form đăng nhập https://evnhanoi.vn/user/login
 * Angular app dùng formcontrolname — không có id truyền thống.
 */
export const hanoiSelectors = {
  /** Input tên đăng nhập */
  username: 'input[formcontrolname="username"]',
  /** Input mật khẩu */
  password: 'input[formcontrolname="password"]',
  /** Nút đăng nhập */
  submitButton: "button.btn-login[type='submit']",
  /** Thông báo lỗi đỏ (sai mật khẩu, tài khoản bị khóa, ...) */
  errorMessage: "p.alert-danger.error-message",
  /** Thông báo lỗi dạng div — phòng trường hợp site thay class */
  errorMessageAlt: ".alert-danger",
  /**
   * Các vị trí lỗi thường gặp (Angular / Material / toast) — thử lần lượt trong readHanoiErrorMessage.
   */
  errorMessageCandidates: [
    "p.alert-danger.error-message",
    ".alert-danger",
    "[role='alert']",
    "mat-error",
    ".mat-mdc-form-field-error",
    ".mat-error",
    ".mdc-form-field__error",
    ".text-danger",
    ".invalid-feedback",
    ".error-message",
    ".message-error",
    "snack-bar-container .mat-mdc-snack-bar-label",
    ".mat-mdc-snack-bar-label",
    ".toast-error",
    ".toast-body",
  ],
  /**
   * Captcha image — EVN Hà Nội hiện tại chưa có captcha trên màn đăng nhập,
   * nhưng giữ selector để xử lý khi site bổ sung sau.
   */
  captchaImage: 'img[class*="captcha" i], img[id*="captcha" i]',
  captchaInput: 'input[id*="captcha" i], input[name*="captcha" i], input[placeholder*="captcha" i]',
  captchaRefresh: 'a[href*="captcha" i], button[id*="refresh" i]',
  /**
   * Popup / overlay sau đăng nhập thành công — đóng trước khi goto tiếp.
   */
  postLoginModalCloseCandidates: [
    "button.close",
    "button.btn-close",
    "[role='dialog'] button.close",
    "[role='dialog'] .btn-close",
    ".modal.show button.close",
    ".modal.show .btn-close",
    ".modal button.close",
    ".modal .close",
  ],
} as const;
