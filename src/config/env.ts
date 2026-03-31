import "dotenv/config";

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolSafe(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseFloatSafe(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  /** Compose/production: set MONGODB_URI hoặc để compose inject mongodb://mongo:27017 */
  mongodbUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017", // fallback chỉ cho dev không có .env
  mongodbDb: process.env.MONGODB_DB ?? "evn_scraper",
  workerConcurrency: parseIntSafe(process.env.WORKER_CONCURRENCY, 3),
  taskPollIntervalMs: parseIntSafe(process.env.TASK_POLL_INTERVAL_MS, 5000),
  playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS !== "false",
  /** Trước khi đóng page/context: chờ N ms (0 = đóng ngay). Hữu ích khi PLAYWRIGHT_HEADLESS=false để theo dõi. */
  playwrightPauseBeforeCloseMs: parseIntSafe(
    process.env.PLAYWRIGHT_PAUSE_BEFORE_CLOSE_MS,
    0,
  ),
  anticaptchaApiKey: process.env.ANTICAPTCHA_API_KEY ?? "",
  /** Base API — endpoint thực tế: `{base}/captcha` */
  anticaptchaApiUrl: process.env.ANTICAPTCHA_API_URL ?? "https://anticaptcha.top/api",
  /** Kiểu captcha: 14 = Image to Text Autodetect (CPC dùng loại này) */
  anticaptchaType: parseIntSafe(process.env.ANTICAPTCHA_TYPE, 14),
  /** Phân biệt hoa/thường: 1 = có (CPC captcha phân biệt) */
  anticaptchaCasesensitive: parseIntSafe(process.env.ANTICAPTCHA_CASESENSITIVE, 1),
  /** Trang đăng nhập CSKH CPC */
  evnCpcLoginUrl: process.env.EVN_CPC_LOGIN_URL ?? "https://cskh.cpc.vn/dang-nhap",
  /** Thử nghiệm: sau này thay bằng pool tài khoản / secret manager */
  evnCpcLoginUsername: process.env.EVN_CPC_LOGIN_USERNAME ?? "",
  evnCpcLoginPassword: process.env.EVN_CPC_LOGIN_PASSWORD ?? "",
  /** Trang tra cứu hóa đơn điện tử (sau đăng nhập) */
  evnCpcLookupUrl:
    process.env.EVN_CPC_LOOKUP_URL ??
    "https://cskh.cpc.vn/dashboard/tra-cuu-hoa-don-dien-tu",
  /** Chuỗi nhận diện request đăng nhập (DevTools → Network) */
  evnCpcCheckExistUserUrlMatch: process.env.EVN_CPC_CHECK_EXIST_USER_URL_MATCH ?? "check-exist-user",
  /** Thư mục lưu file PDF tải về — tạo tự động nếu chưa tồn tại */
  pdfOutputDir: process.env.PDF_OUTPUT_DIR ?? "./output/pdfs",
  /** Base URL API hóa đơn CPC */
  evnCpcApiBaseUrl: process.env.EVN_CPC_API_BASE_URL ?? "https://cskh-api.cpc.vn/api",
  /** Giới hạn gọi API PDF mỗi phút (CPC quota ~100/min). Đặt thấp hơn để có headroom an toàn. */
  evnCpcPdfMaxPerMinute: parseIntSafe(process.env.EVN_CPC_PDF_MAX_PER_MINUTE, 90),
  /** Số lần retry tối đa khi API PDF trả 429 */
  evnCpcPdf429MaxRetries: parseIntSafe(process.env.EVN_CPC_PDF_429_MAX_RETRIES, 6),
  /** Delay backoff ban đầu (ms) khi gặp 429 */
  evnCpcPdf429BaseDelayMs: parseIntSafe(process.env.EVN_CPC_PDF_429_BASE_DELAY_MS, 1500),
  /** Số lượt quét retry PDF lỗi trong cùng task (sau lượt tải đầu). */
  evnCpcPdfRetrySweeps: parseIntSafe(process.env.EVN_CPC_PDF_RETRY_SWEEPS, 1),
  /** Thời gian chờ giữa các lượt quét retry PDF lỗi. */
  evnCpcPdfRetrySweepDelayMs: parseIntSafe(process.env.EVN_CPC_PDF_RETRY_SWEEP_DELAY_MS, 30000),
  /** Port HTTP API server */
  apiPort: parseIntSafe(process.env.API_PORT, 1371),
  /** Base URL public để gateway gọi vào (qua domain/tunnel/proxy) */
  evnAutocheckBaseUrl: process.env.EVN_AUTOCHECK_BASE_URL ?? "http://localhost:1371",
  /** Bật/tắt auth API-key cho toàn bộ API */
  apiKeyAuthEnabled: parseBoolSafe(process.env.API_KEY_AUTH_ENABLED, false),
  /** API-key dùng header `x-api-key` */
  apiKey: process.env.API_KEY ?? "",

  /**
   * Mức log: debug | info | warn | error (mặc định info).
   * `debug`: từng file PDF, captcha chi tiết; `info`: các mốc pipeline task + cảnh báo/lỗi.
   */
  logLevel: process.env.LOG_LEVEL ?? "info",

  /** Emulate mobile layout để tránh UI desktop vỡ (react-select/menu khó click) */
  playwrightMobileMode: parseBoolSafe(process.env.PLAYWRIGHT_MOBILE_MODE, false),
  playwrightMobileViewportWidth: parseIntSafe(process.env.PLAYWRIGHT_MOBILE_WIDTH, 390),
  playwrightMobileViewportHeight: parseIntSafe(process.env.PLAYWRIGHT_MOBILE_HEIGHT, 844),

  /** CSKH NPC — đăng nhập khách hàng (Mã KH) */
  evnNpcLoginUrl:
    process.env.EVN_NPC_LOGIN_URL ?? "https://cskh.npc.com.vn/home/AccountNPC",
  /** Trang chủ sau đăng nhập — dùng thử session */
  evnNpcHomeUrl: process.env.EVN_NPC_HOME_URL ?? "https://cskh.npc.com.vn/home",
  /**
   * Sau đăng nhập thành công (redirect về gốc site) — bước tiếp theo pipeline NPC.
   * Mặc định: Dịch vụ TT CSKH NPC (index=2).
   */
  evnNpcIndexNpcUrl:
    process.env.EVN_NPC_INDEX_NPC_URL ??
    "https://cskh.npc.com.vn/DichVuTTCSKH/IndexNPC?index=2",
  /** Origin CSKH NPC — dùng cho API same-origin sau đăng nhập */
  evnNpcBaseUrl: process.env.EVN_NPC_BASE_URL ?? "https://cskh.npc.com.vn",
  /**
   * Đường dẫn trang "Thanh toán trực tuyến — Thanh toán tiền điện" (sau đăng nhập).
   * @see https://cskh.npc.com.vn/DichVuTrucTuyen/ThanhToanTrucTuyenNPC_TTTD
   */
  evnNpcThanhToanTrucTuyenPath:
    process.env.EVN_NPC_THANH_TOAN_TRUC_TUYEN_PATH ?? "DichVuTrucTuyen/ThanhToanTrucTuyenNPC_TTTD",
  /**
   * `true`: sau khi vào IndexNPC và lưu session, gọi thêm POST Tra cứu thanh toán trực tuyến và gắn `onlinePaymentLink` vào metadata task.
   */
  npcFetchOnlinePaymentLinkAfterLogin: parseBoolSafe(process.env.NPC_FETCH_ONLINE_PAYMENT_LINK_AFTER_LOGIN, false),
  /**
   * Bí mật dài (≥16 ký tự khuyến nghị) để mã hóa mật khẩu lưu trong npc_accounts.
   * Bắt buộc khi gọi API thêm tài khoản NPC.
   */
  npcCredentialsSecret: process.env.NPC_CREDENTIALS_SECRET ?? "",
  /**
   * `true`: khi khởi động `node dist/index.js`, nếu tồn tại file `NPC_ACCOUNTS_XLSX_PATH` thì import vào `npc_accounts`
   * (trùng username → skip). Cần `NPC_CREDENTIALS_SECRET`. Tắt mặc định — bật trên máy chủ sau khi đặt file Excel vào thư mục `data/`.
   */
  autoImportNpcXlsxOnStart: parseBoolSafe(process.env.AUTO_IMPORT_NPC_XLSX, false),
  /** Đường dẫn file .xlsx (cột A=username, B=password), ví dụ `./data/npc-accounts.xlsx` */
  npcAccountsXlsxPath: process.env.NPC_ACCOUNTS_XLSX_PATH ?? "./data/npc-accounts.xlsx",
  /**
   * `true`: in `[npc-login+timing]` / `[captcha+timing]` ra console (không phụ thuộc LOG_LEVEL) để tìm bước chậm.
   */
  npcLoginTraceTiming: parseBoolSafe(process.env.NPC_LOGIN_TRACE_TIMING, false),
  /**
   * Số lần thử tối đa khi NPC báo sai captcha (HTML SSR / màn đăng nhập).
   * Mặc định 5 — có thể giảm qua env khi test.
   */
  npcCaptchaMaxAttempts: Math.min(10, Math.max(1, parseIntSafe(process.env.NPC_CAPTCHA_MAX_ATTEMPTS, 5))),
  /**
   * Hệ số phóng ảnh captcha NPC trước khi chụp gửi anticaptcha (trước đây cố định ×3).
   * Tăng (vd. 4–5) giúp OCR ổn định hơn; quá cao có thể làm file PNG nặng.
   */
  npcCaptchaImageScale: Math.min(8, Math.max(2, parseFloatSafe(process.env.NPC_CAPTCHA_IMAGE_SCALE, 4))),
  /**
   * Sau khi nhân scale, nếu chiều cao ảnh (px) vẫn nhỏ hơn giá trị này thì phóng thêm tỉ lệ
   * (giữ nguyên tỉ lệ khung) — hữu ích khi captcha hiển thị rất thấp trên UI.
   * 0 = tắt.
   */
  npcCaptchaImageMinHeightPx: Math.max(0, parseIntSafe(process.env.NPC_CAPTCHA_IMAGE_MIN_HEIGHT_PX, 96)),
  /** Timeout mỗi bước Playwright NPC (goto, probe) — máy chủ mạng chậm nên tăng (ms). */
  npcStepTimeoutMs: Math.max(15_000, parseIntSafe(process.env.NPC_STEP_TIMEOUT_MS, 90_000)),
  /** GET TraCuuHDSPC: retry khi 403/429/502 (WAF tạm chặn). 0 = không retry. */
  npcTraCuuMaxRetries: Math.min(5, Math.max(0, parseIntSafe(process.env.NPC_TRACUU_MAX_RETRIES, 2))),
  npcTraCuuRetryDelayMs: Math.max(0, parseIntSafe(process.env.NPC_TRACUU_RETRY_DELAY_MS, 2500)),
  /**
   * NPC (chống bot): chờ ngẫu nhiên [min,max] ms giữa các bước TraCuu / XemChiTiet.
   * Đặt cả hai = 0 để tắt (chỉ dùng khi test nhanh).
   */
  npcHumanJitterMinMs: Math.max(0, parseIntSafe(process.env.NPC_HUMAN_JITTER_MIN_MS, 120)),
  npcHumanJitterMaxMs: Math.max(0, parseIntSafe(process.env.NPC_HUMAN_JITTER_MAX_MS, 500)),
  /** `false`: chỉ tải PDF thông báo (XemChiTiet), không gọi XemHoaDon_NPC. */
  npcDownloadPaymentPdf: parseBoolSafe(process.env.NPC_DOWNLOAD_PAYMENT_PDF, true),
  /**
   * `true`: cho phép POST ` /api/npc/accounts/replace-bulk` (xóa hết npc_accounts rồi nạp JSON).
   * Mặc định tắt — chỉ bật tạm khi vận hành; nên dùng CLI `replace:npc-accounts:xlsx` cho file Excel.
   */
  npcAllowAccountReplaceBulk: parseBoolSafe(process.env.NPC_ALLOW_ACCOUNT_REPLACE_BULK, false),
  /** `false`: tắt POST `/api/npc/online-payment-link` (mở Playwright — tốn tài nguyên). */
  npcOnlinePaymentLinkApiEnabled: parseBoolSafe(process.env.NPC_ONLINE_PAYMENT_LINK_API_ENABLED, true),
  /**
   * `true`: cho phép body `{ "sync": true }` trên POST `/api/npc/online-payment-link` chạy đồng bộ (dễ timeout).
   * Mặc định tắt — agent dùng async (202 + poll task).
   */
  npcOnlinePaymentLinkSyncApiEnabled: parseBoolSafe(process.env.NPC_ONLINE_PAYMENT_LINK_SYNC_API_ENABLED, false),
};
