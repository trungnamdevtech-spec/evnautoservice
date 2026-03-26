/**
 * Selector EVN CPC — đăng nhập + tra cứu hóa đơn điện tử
 * https://cskh.cpc.vn/dashboard/tra-cuu-hoa-don-dien-tu
 */
export const evnCpcSelectors = {
  loginUsername: 'input[name="username"].cpc-input',
  loginPassword: 'input[name="password"].cpc-input',
  loginSubmitButton: "button.login-button___dMmrc",

  /** Form tra cứu (class có hash build — ưu tiên `has(...)`) */
  invoiceLookupForm: 'form:has(input[name="period"])',
  /** react-select bọc bởi CPC (`cskh-custom-select`) — không phải `.ant-select` */
  invoiceLookupReactSelect: ".cskh-custom-select",
  invoicePeriodHidden: 'input[name="period"]',
  invoiceMonthHidden: 'input[name="month"]',
  invoiceYearHidden: 'input[name="year"]',

  captchaImage: 'form:has(input[name="period"]) img[alt="captcha"]',
  captchaInput: 'input[name="captcha"]',
  /** Trang dùng `<p>Thay đổi</p>` thay vì nút "Thay đổi mã" */
  changeCaptchaLink: 'form:has(input[name="captcha"]) p:has-text("Thay đổi")',
  /** Nút kính lúp tra cứu — selector đứng độc lập, không ghép thêm form prefix */
  invoiceSearchButton: 'form:has(input[name="captcha"]) button[class*="action-button"]',

  /** Lỗi sau khi tra cứu (điều chỉnh theo DOM thực tế) */
  invoiceLookupError: ".toast-body, [role=\"alert\"], .swal2-html-container, .text-danger",

  /** Xuất file (bảng kết quả) */
  exportFileButton: 'button:has-text("XUẤT FILE")',
} as const;
