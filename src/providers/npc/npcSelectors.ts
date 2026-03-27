/** Form đăng nhập https://cskh.npc.com.vn/home/AccountNPC */
export const npcSelectors = {
  /** Bắt buộc: chọn loại đăng nhập "Mã Khách hàng sử dụng điện" trước khi có form đầy đủ */
  btnTaiKhoan: "#btnTaiKhoan",
  loginForm: "#login-form",
  username: "#frmDangKy_TenDangNhap_DN",
  password: "#frmDangKy_MatKhau_DN",
  captchaImage: "#CaptchaImage",
  captchaInput: "#CaptchaInputText",
  /** Link "Làm mới" cạnh captcha */
  captchaRefresh: 'a[href="#CaptchaImage"]',
  submitButton: "#login-form button.btn-send-contact",
  /** Thông báo lỗi đỏ dưới form */
  formErrorParagraph: 'form#login-form p[style="color:red"]',
  /** Validation ASP.NET khi captcha sai */
  captchaFieldError: '[data-valmsg-for="CaptchaInputText"].field-validation-error',
  /**
   * Popup cảnh báo / quảng cáo sau đăng nhập (che trang — cần đóng trước khi goto tiếp).
   * Thử lần lượt trong code đóng modal.
   */
  postLoginModalCloseCandidates: [
    /** Popup EVNNPC: dialog UIkit với nút close mặc định */
    ".uk-modal-dialog button.uk-modal-close-default.uk-close",
    "button.uk-modal-close-default.uk-close",
    "button.uk-modal-close-default",
    "button[uk-close]",
    '[role="dialog"] button[aria-label="Close"]',
    '[role="dialog"] .btn-close',
    ".uk-modal-close",
    "a.uk-modal-close",
    ".modal.show button.close",
    ".modal.show .btn-close",
    ".modal button.close",
    ".modal .close",
    'button[class*="close"][class*="btn"]',
  ],
  /** Nhận diện đúng popup ảnh cảnh báo tiền điện sau login. */
  postLoginPopupDialog: ".uk-modal-dialog",
  postLoginPopupImage: 'img[src*="Popup hóa đơn"], img[src*="Popup%20hóa%20đơn"], img[src*="Popup"]',
} as const;
