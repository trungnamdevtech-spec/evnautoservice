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
  /**
   * Khởi động: đánh dấu FAILED mọi task đang `RUNNING` (sót sau crash / SIGKILL giữa chừng).
   * Tắt (`false`) nếu chạy **nhiều replica worker** cùng một DB — có thể fail nhầm task đang xử lý ở instance khác.
   */
  taskFailRunningOnStartup: parseBoolSafe(process.env.TASK_FAIL_RUNNING_ON_STARTUP, true),
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
  /**
   * Timeout mỗi bước Playwright NPC (goto từng trang, captcha, …). Link thanh toán cũng dùng chung —
   * nếu đặt thấp (vd. 45000) mà `npc:probeSession` chậm sẽ fail trước khi tới bước lấy link. Khuyến nghị ≥90000 trên server.
   */
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

  // ── EVN Hà Nội ────────────────────────────────────────────────────────────

  /** Trang đăng nhập EVN Hà Nội (Angular app) */
  evnHanoiLoginUrl: process.env.EVN_HANOI_LOGIN_URL ?? "https://evnhanoi.vn/user/login",
  /** Origin EVN Hà Nội — dùng cho API same-origin sau đăng nhập */
  evnHanoiBaseUrl: process.env.EVN_HANOI_BASE_URL ?? "https://evnhanoi.vn",
  /**
   * Bí mật dài (≥16 ký tự khuyến nghị) để mã hóa mật khẩu lưu trong hanoi_accounts.
   * Bắt buộc khi gọi API thêm tài khoản Hà Nội.
   */
  hanoiCredentialsSecret: process.env.HANOI_CREDENTIALS_SECRET ?? "",
  /** Timeout mỗi bước Playwright Hanoi (goto, probe) — ms. */
  hanoiStepTimeoutMs: Math.max(15_000, parseIntSafe(process.env.HANOI_STEP_TIMEOUT_MS, 90_000)),
  /** Số lần thử tối đa khi Hanoi báo sai captcha. */
  hanoiCaptchaMaxAttempts: Math.min(10, Math.max(1, parseIntSafe(process.env.HANOI_CAPTCHA_MAX_ATTEMPTS, 5))),
  /** Chờ ngẫu nhiên [min,max] ms giữa các bước — chống bot. */
  hanoiHumanJitterMinMs: Math.max(0, parseIntSafe(process.env.HANOI_HUMAN_JITTER_MIN_MS, 120)),
  hanoiHumanJitterMaxMs: Math.max(0, parseIntSafe(process.env.HANOI_HUMAN_JITTER_MAX_MS, 500)),
  /** `false`: tắt POST `/api/hanoi/online-payment-link`. */
  hanoiOnlinePaymentLinkApiEnabled: parseBoolSafe(process.env.HANOI_ONLINE_PAYMENT_LINK_API_ENABLED, true),
  /**
   * POST `GetListThongTinNoKhachHang`: khi HTTP 200 nhưng list trống / thiếu URL — server EVN đôi khi trả tạm rỗng nếu gọi dày.
   * Số lần **gọi lại thêm** sau lần đầu thất bại (mặc định 3 → tối đa 4 lần HTTP).
   */
  hanoiOnlinePaymentTracuuMaxRetries: Math.min(8, Math.max(0, parseIntSafe(process.env.HANOI_ONLINE_PAYMENT_TRACUU_MAX_RETRIES, 3))),
  /** Cơ sở chờ giữa các lần retry khi list trống (ms). */
  hanoiOnlinePaymentTracuuRetryDelayMs: Math.max(200, parseIntSafe(process.env.HANOI_ONLINE_PAYMENT_TRACUU_RETRY_DELAY_MS, 1500)),
  /**
   * Chờ trước lần đầu gọi `GetListThongTinNoKhachHang` (sau userinfo/hợp đồng) — trang EVN HN load chậm,
   * gọi sớm dễ trả list rỗng; 0 = tắt.
   */
  hanoiOnlinePaymentTracuuPreDelayMs: Math.max(0, parseIntSafe(process.env.HANOI_ONLINE_PAYMENT_TRACUU_PRE_DELAY_MS, 2500)),
  /**
   * `true`: cho phép POST `/api/hanoi/accounts/replace-bulk`.
   * Mặc định tắt — chỉ bật tạm khi vận hành.
   */
  hanoiAllowAccountReplaceBulk: parseBoolSafe(process.env.HANOI_ALLOW_ACCOUNT_REPLACE_BULK, false),
  /**
   * `true`: khi khởi động, nếu tồn tại file `HANOI_ACCOUNTS_XLSX_PATH` thì import vào `hanoi_accounts`.
   * Tắt mặc định.
   */
  autoImportHanoiXlsxOnStart: parseBoolSafe(process.env.AUTO_IMPORT_HANOI_XLSX, false),
  /** Đường dẫn file .xlsx (cột A=username, B=password, C=label?). */
  hanoiAccountsXlsxPath: process.env.HANOI_ACCOUNTS_XLSX_PATH ?? "./data/hanoi-accounts.xlsx",
  /** `false`: chỉ tải PDF thông báo, không gọi thêm PDF GTGT. */
  hanoiDownloadPaymentPdf: parseBoolSafe(process.env.HANOI_DOWNLOAD_PAYMENT_PDF, true),
  /** GET Tra cứu Hanoi: retry khi 403/429/502. 0 = không retry. */
  hanoiTraCuuMaxRetries: Math.min(5, Math.max(0, parseIntSafe(process.env.HANOI_TRACUU_MAX_RETRIES, 2))),
  hanoiTraCuuRetryDelayMs: Math.max(0, parseIntSafe(process.env.HANOI_TRACUU_RETRY_DELAY_MS, 2500)),
  /** Timeout GET `/api/TraCuu/GetThongTinHoaDon` (ms). */
  hanoiTraCuuGetThongTinTimeoutMs: Math.max(
    10_000,
    parseIntSafe(process.env.HANOI_TRACUU_GET_THONG_TIN_TIMEOUT_MS, 120_000),
  ),
  /** Timeout GET `/api/Cmis/XemHoaDonByMaKhachHang` (ms). */
  hanoiPdfXemHoaDonTimeoutMs: Math.max(
    15_000,
    parseIntSafe(process.env.HANOI_PDF_XEM_HOA_DON_TIMEOUT_MS, 180_000),
  ),
  /** Tham số `loaiHoaDon` — PDF thông báo tiền điện (mặc định TD như web). */
  hanoiPdfLoaiTienDien: (process.env.HANOI_PDF_LOAI_TIEN_DIEN ?? "TD").trim() || "TD",
  /** Tham số `loaiHoaDon` — PDF hóa đơn GTGT (thử khi tải bản thứ hai). */
  hanoiPdfLoaiGtgt: (process.env.HANOI_PDF_LOAI_GTGT ?? "GTGT").trim() || "GTGT",
  /**
   * `true`: in log timing đăng nhập Hanoi ra console.
   */
  hanoiLoginTraceTiming: parseBoolSafe(process.env.HANOI_LOGIN_TRACE_TIMING, false),
  /**
   * Sau khi bấm Đăng nhập (Playwright): chờ tối thiểu trước khi đánh giá kết quả.
   * Trang EVN Hà Nội thường redirect sau ~3–6s — mặc định 6000ms.
   */
  hanoiLoginPostSubmitMinSettleMs: Math.max(
    0,
    parseIntSafe(process.env.HANOI_LOGIN_POST_SUBMIT_MIN_MS, 6000),
  ),
  /**
   * Thời gian chờ tối đa cho redirect hoặc hiện thông báo lỗi sau submit (ms).
   */
  hanoiLoginPostSubmitMaxMs: Math.max(
    5000,
    parseIntSafe(process.env.HANOI_LOGIN_POST_SUBMIT_MAX_MS, 25_000),
  ),
  /** Thời gian quét DOM để đọc thông báo lỗi sau submit (ms). */
  hanoiLoginErrorProbeMs: Math.max(
    3000,
    parseIntSafe(process.env.HANOI_LOGIN_ERROR_PROBE_MS, 8000),
  ),

  /**
   * `true` (mặc định): đăng nhập EVN Hà Nội qua API `POST .../connect/token` — không mở Chromium.
   * `false`: dùng Playwright như trước (fallback khi STS thay đổi / cần captcha).
   */
  hanoiUseApiLogin: parseBoolSafe(process.env.HANOI_USE_API_LOGIN, true),
  /** URL STS OAuth2 password grant (EVN Hà Nội). */
  hanoiStsTokenUrl:
    process.env.HANOI_STS_TOKEN_URL ?? "https://apicskh.evnhanoi.vn/connect/token",
  /** client_id gửi kèm grant password — khớp web app. */
  hanoiStsClientId: process.env.HANOI_STS_CLIENT_ID ?? "httplocalhost4500",
  /** client_secret — có thể override qua env production. */
  hanoiStsClientSecret: process.env.HANOI_STS_CLIENT_SECRET ?? "secret",
  /** Timeout (ms) cho request lấy token. */
  hanoiStsTokenTimeoutMs: Math.max(10_000, parseIntSafe(process.env.HANOI_STS_TOKEN_TIMEOUT_MS, 120_000)),
  /**
   * Làm mới token trước khi hết hạn (giây). Mặc định 300s = 5 phút trước expires_in.
   */
  hanoiApiTokenRefreshBufferSec: Math.max(60, parseIntSafe(process.env.HANOI_API_TOKEN_REFRESH_BUFFER_SEC, 300)),
  /**
   * `true`: cho phép POST `/api/hanoi/online-payment-link` với body `{ "sync": true }` chạy đồng bộ.
   * Mặc định tắt — agent dùng async (202 + poll task).
   */
  hanoiOnlinePaymentLinkSyncApiEnabled: parseBoolSafe(
    process.env.HANOI_ONLINE_PAYMENT_LINK_SYNC_API_ENABLED,
    false,
  ),

  /** GET OpenID userinfo — Bearer access_token. */
  hanoiStsUserInfoUrl:
    process.env.HANOI_STS_USERINFO_URL ?? "https://apicskh.evnhanoi.vn/connect/userinfo",
  /** Timeout (ms) cho GET userinfo. */
  hanoiUserInfoTimeoutMs: Math.max(5_000, parseIntSafe(process.env.HANOI_USERINFO_TIMEOUT_MS, 60_000)),
  /**
   * Không gọi lại userinfo nếu đã có maDvql + maKhachHang và lần fetch gần nhất chưa quá N ms.
   * 0 = mỗi lần chạy task đều gọi lại userinfo (mặc định).
   */
  hanoiUserInfoRefreshMinMs: Math.max(0, parseIntSafe(process.env.HANOI_USERINFO_REFRESH_MIN_MS, 0)),

  /** GET `/api/TraCuu/GetDanhSachHopDongByUserName` — timeout (ms). */
  hanoiHopDongTimeoutMs: Math.max(15_000, parseIntSafe(process.env.HANOI_HOP_DONG_TIMEOUT_MS, 120_000)),
  /**
   * Không gọi lại danh sách hợp đồng nếu hopDongFetchedAt chưa quá N ms. 0 = mỗi task đều đồng bộ.
   */
  hanoiHopDongRefreshMinMs: Math.max(0, parseIntSafe(process.env.HANOI_HOP_DONG_REFRESH_MIN_MS, 0)),

  /**
   * POST JSON tới URL này khi worker ghi SUCCESS/FAILED cho mọi task (EVN_CPC / EVN_NPC).
   * Để trống = tắt webhook.
   */
  agentTaskWebhookUrl: (process.env.AGENT_TASK_WEBHOOK_URL ?? "").trim(),
  /** Ký HMAC-SHA256 body (hex) — header `X-Agent-Task-Signature: sha256=<hex>`. Để trống = không ký. */
  agentTaskWebhookSecret: (process.env.AGENT_TASK_WEBHOOK_SECRET ?? "").trim(),
  agentTaskWebhookTimeoutMs: Math.max(1000, parseIntSafe(process.env.AGENT_TASK_WEBHOOK_TIMEOUT_MS, 15_000)),

  /**
   * POST JSON khi PATCH mật khẩu Hanoi + kết quả kiểm tra STS (tách biệt webhook task).
   * Header ký (tuỳ chọn): `X-Hanoi-Account-Signature: sha256=<hex>`.
   */
  hanoiAccountWebhookUrl: (process.env.HANOI_ACCOUNT_WEBHOOK_URL ?? "").trim(),
  hanoiAccountWebhookSecret: (process.env.HANOI_ACCOUNT_WEBHOOK_SECRET ?? "").trim(),
  hanoiAccountWebhookTimeoutMs: Math.max(1000, parseIntSafe(process.env.HANOI_ACCOUNT_WEBHOOK_TIMEOUT_MS, 15_000)),

  /**
   * Cho phép agent POST `/api/hanoi/sync-known-ma` (đồng bộ userinfo/hợp đồng → `knownMaKhachHang`).
   * Mặc định tắt — bật `HANOI_SYNC_KNOWN_MA_API_ENABLED=true` khi triển khai.
   */
  hanoiSyncKnownMaApiEnabled: parseBoolSafe(process.env.HANOI_SYNC_KNOWN_MA_API_ENABLED, false),

  /**
   * Job đồng bộ ở trạng thái `running` quá N ms (API restart / treo) → GET job sẽ ghi nhận `failed`.
   * Mặc định 4 giờ.
   */
  hanoiSyncJobStaleRunningMs: Math.max(
    60_000,
    parseIntSafe(process.env.HANOI_SYNC_JOB_STALE_RUNNING_MS, 14_400_000),
  ),
  /** Giữ tối đa N job trong `hanoi_sync_jobs` (xóa bản ghi cũ sau mỗi lần hoàn thành). */
  hanoiSyncJobMaxKeep: Math.max(10, parseIntSafe(process.env.HANOI_SYNC_JOB_MAX_KEEP, 500)),
};
