# EVN Hà Nội — API Agent & vận hành production

Phiên bản tài liệu đồng bộ với header `X-API-Version` / `src/api/contract.ts` (hiện **1.6.1**).

**OpenAPI:** `docs_autocheckenv/openapi.yaml` — tag **`hanoi`**.  
**Webhook task:** `AGENT_GATEWAY_TASK_WEBHOOK.md` (repo root) — `event: task.finished`.  
**Ngữ cảnh miền:** `docs_autocheckenv/PROJECT_CONTEXT.md`.

---

## 1. Tổng quan

- **Provider:** `EVN_HANOI` — dữ liệu trong MongoDB collection `electricity_bills` (`provider: "EVN_HANOI"`), task trong `scrape_tasks`.
- **Đăng nhập mặc định:** STS OAuth2 `POST …/connect/token` (Bearer), **không bắt buộc Chromium** khi `HANOI_USE_API_LOGIN=true` (mặc định).
- **Agent** tích hợp qua REST: cache trước (`ensure-bill`), poll task, đọc kết quả; tùy chọn nhận webhook.

---

## 2. Xác thực

| Điều kiện | Header |
|-----------|--------|
| `API_KEY_AUTH_ENABLED=true` (khuyến nghị production) | `x-api-key: <API_KEY>` |

Thiếu/không khớp → **401** `{"error":"Unauthorized: invalid or missing x-api-key"}`.

---

## 3. Biến môi trường (tối thiểu)

| Biến | Ý nghĩa |
|------|---------|
| `MONGODB_URI` / `MONGODB_DB` | Lưu tài khoản, task, bill |
| `HANOI_CREDENTIALS_SECRET` | Giải mã mật khẩu đã lưu (AES-256-GCM) |
| `HANOI_STS_CLIENT_ID` / `HANOI_STS_CLIENT_SECRET` | Password grant STS (khớp web app EVN HN) |
| `API_KEY` + `API_KEY_AUTH_ENABLED=true` | Bảo vệ API public |
| `AGENT_TASK_WEBHOOK_URL` (tuỳ chọn) | Nhận `task.finished` + `hanoi.ensure_bill` |
| `AGENT_TASK_WEBHOOK_SECRET` (tuỳ chọn) | HMAC SHA-256, header `X-Agent-Task-Signature` |

Tắt/bật tính năng:

| Biến | Mặc định | Ý nghĩa |
|------|-----------|---------|
| `HANOI_ONLINE_PAYMENT_LINK_API_ENABLED` | `true` | `false` → **403** `FEATURE_DISABLED` trên `POST /online-payment-link` |
| `HANOI_ONLINE_PAYMENT_LINK_SYNC_API_ENABLED` | `false` | `true` + body `sync: true` mới chạy đồng bộ (dễ timeout) |
| `HANOI_SYNC_KNOWN_MA_API_ENABLED` | `false` | Bật mới gọi được `POST /sync-known-ma` |
| `HANOI_USE_API_LOGIN` | `true` | `false` → worker dùng Playwright (fallback) |

---

## 4. Luồng Agent khuyến nghị

### 4.1 Có hóa đơn / tra cứu theo kỳ

1. **`POST /api/hanoi/ensure-bill`**  
   Body: **đúng một** trong `username` (đăng nhập CSKH) **hoặc** `maKhachHang` (mã KH); kỳ: `ky` \| `period`, `thang` \| `month`, `nam` \| `year`.

2. **200 `outcome: cache_hit`** — đã có bản parse trong DB (ưu tiên PDF tiền điện `tien_dien`).  
   Có thể nhận webhook `event: hanoi.ensure_bill` (nếu cấu hình).

3. **202 `outcome: queued` \| `already_queued`** — poll **`GET /api/tasks/:taskId`** tới `SUCCESS` \| `FAILED`.

4. **`GET /api/hanoi/bills?maKhachHang=...`** — danh sách `electricity_bills` đã parse.

**Lưu ý:** Với `maKhachHang`, hệ thống **tra DB trước** khi resolve tài khoản — không gọi EVN nếu đã có dữ liệu.

### 4.2 Link thanh toán (API EVN: `GetListThongTinNoKhachHang`)

1. **`POST /api/hanoi/online-payment-link`**  
   Chọn **một** cách xác định tài khoản: `hanoiAccountId` **hoặc** `hanoiAccountUsername` **hoặc** `maKhachHang` (resolve đúng 1 account).  
   Tuỳ chọn `maKhachHang` thứ hai: mã KH cần lấy link (mặc định lấy từ tài khoản).

2. Mặc định **202** + `taskId` → poll **`GET /api/tasks/:taskId`**.

3. Kết quả: `resultMetadata.lookupPayload.onlinePaymentLink`:
   - Thành công: `{ ok: true, paymentUrl, maKhachHang, httpStatus }` — `paymentUrl` = `urlThanhToan` từ EVN.
   - Nghiệp vụ: `{ ok: false, code, reason, ... }` — ví dụ `EMPTY_DEBT_LIST`, `API_BUSINESS_ERROR` (task vẫn có thể `SUCCESS` nếu không lỗi kỹ thuật — xem code worker).

**Sync:** chỉ khi `HANOI_ONLINE_PAYMENT_LINK_SYNC_API_ENABLED=true` và `"sync": true` → **200** JSON trực tiếp (không tạo task).

---

## 5. Bảng endpoint (rút gọn)

| Method | Path | Mô tả |
|--------|------|--------|
| `GET` | `/` | Discovery + `catalogReference` (gồm file tài liệu) |
| `POST` | `/api/hanoi/accounts` | Thêm tài khoản `{ username, password, label? }` |
| `POST` | `/api/hanoi/accounts/bulk` | Import hàng loạt |
| `POST` | `/api/hanoi/accounts/replace-bulk` | Xóa hết + nạp (cần env + `confirmation`) |
| `GET` | `/api/hanoi/accounts` | Danh sách; `?username=` **hoặc** `?maKhachHang=` (một account / nhiều nếu cùng MA) |
| `GET` | `/api/hanoi/accounts/stats` | Đếm trạng thái tài khoản |
| `GET` | `/api/hanoi/accounts/list-all` | Phân trang + `credentialStatus` |
| `GET` | `/api/hanoi/accounts/wrong-credentials` | TK sai mật khẩu |
| `GET` | `/api/hanoi/contracts` | `?hanoiAccountId=` **hoặc** `?maKhachHang=` — hợp đồng đã đồng bộ |
| `PATCH` | `/api/hanoi/accounts/:id` | `enabled` / `password` + verify STS |
| `PUT` | `/api/hanoi/accounts/:id/password` | Chỉ đổi mật khẩu |
| `POST` | `/api/hanoi/sync-known-ma` | Job đồng bộ `knownMaKhachHang` (cần env) |
| `GET` | `/api/hanoi/sync-known-ma/jobs` | Danh sách job |
| `GET` | `/api/hanoi/sync-known-ma/jobs/:jobId` | Chi tiết job |
| `POST` | `/api/hanoi/ensure-bill` | Cache hoặc queue (mục 4.1) |
| `GET` | `/api/hanoi/bills` | `?maKhachHang=` bắt buộc |
| `POST` | `/api/hanoi/online-payment-link` | Link thanh toán (mục 4.2) |
| `POST` | `/api/hanoi/tasks` | Tạo task quét: `hanoiAccountId` \| `maKhachHang` + kỳ/tháng/năm |
| `POST` | `/api/hanoi/tasks/enqueue-all-enabled` | Queue tất cả TK enabled cùng kỳ |
| `GET` | `/api/tasks/:taskId` | Poll trạng thái + `resultMetadata` (chung CPC/NPC/Hanoi) |

### 5.1 Excel (`/api/export/*`)

Cùng cơ chế **query `region` hoặc `provider`** với bills/stats. Để xuất **chỉ EVN Hà Nội**, bắt buộc truyền **`region=EVN_HANOI`** (hoặc `provider=EVN_HANOI`).  
Không truyền → mặc định **EVN_CPC** (không gồm bản ghi Hanoi).

- `GET /api/export/period?ky=&thang=&nam=&region=EVN_HANOI`
- `GET /api/export/month?thang=&nam=&region=EVN_HANOI`
- `GET /api/export/customer/:maKH?region=EVN_HANOI&ky=&thang=&nam=`

### 5.2 PDF đã lưu (không dùng `invoice_items` CPC)

`/api/pdf/invoice/:invoiceId` và `/api/pdf/customer/...` (không tiền tố npc/hanoi) đọc collection **`invoice_items`** — **chỉ CPC**. Với Hanoi, dùng:

| Method | Path | Mô tả |
|--------|------|--------|
| `GET` | `/api/pdf/hanoi/:invoiceId` | Tải file PDF — `invoiceId` = cột `electricity_bills.invoiceId` (**provider EVN_HANOI**), tra từ `GET /api/hanoi/bills` hoặc list bên dưới |
| `GET` | `/api/pdf/hanoi/customer/:maKhachHang/list` | Liệt kê bản ghi đã parse + `downloadUrl` |

---

## 6. Webhook (Agent Gateway)

Cùng URL `AGENT_TASK_WEBHOOK_URL` (nếu set):

| `event` | Khi nào |
|---------|---------|
| `task.finished` | Task `SUCCESS` / `FAILED` — payload task + `resultMetadata` |
| `hanoi.ensure_bill` | `POST /ensure-bill` trả **cache_hit** hoặc **already_queued** (không chờ worker) |

Chữ ký: `X-Agent-Task-Signature: sha256=<hex>` khi có `AGENT_TASK_WEBHOOK_SECRET` (cùng thuật toán như `task.finished`).

**Hợp đồng đầy đủ + mẫu JSON + cách map `chat_id` / Telegram (Gateway):** xem **`AGENT_GATEWAY_TASK_WEBHOOK.md`** ở root repo — **mục 6** (`hanoi.ensure_bill`). Lưu ý: **`cache_hit` không có `taskId`** — Gateway cần lưu khóa `(maKhachHang + period)` khi user gọi ensure-bill, hoặc sau này bổ sung `correlationId` phía API nếu sản phẩm yêu cầu.

---

## 7. Rủi ro & kiểm tra production

1. **Trùng / mơ hồ mã KH:** Nhiều `hanoi_accounts` cùng `maKhachHang` → **409** `AMBIGUOUS` khi resolve; cần đồng bộ `knownMaKhachHang` hoặc chỉ định `hanoiAccountId`.
2. **Task trùng kỳ:** `findActiveHanoiForPeriod` — không tạo hai task PENDING/RUNNING cùng tài khoản + cùng kỳ/tháng/năm.
3. **Link thanh toán:** API EVN có thể trả danh sách nợ rỗng → `EMPTY_DEBT_LIST`; không phải lỗi hệ thống.
4. **Worker / API khác phiên bản:** Restart process sau deploy để nạp code mới (task đã SUCCESS với payload cũ không tự sửa).
5. **`HANOI_USE_API_LOGIN=false`:** Tốn tài nguyên Chromium — chỉ dùng khi STS lỗi tạm thời.

---

## 8. Mã lỗi thường gặp (HTTP + `code`)

| HTTP | `code` / tình huống |
|------|---------------------|
| 400 | `VALIDATION_*`, `HANOI_ACCOUNT_DISABLED`, `VALIDATION_USERNAME_OR_MA` |
| 403 | `FEATURE_DISABLED` (API tắt env) |
| 404 | `HANOI_ACCOUNT_NOT_FOUND`, `HANOI_MA_KH_NOT_LINKED` |
| 409 | `AMBIGUOUS` (nhiều account cho một MA_KH) |
| 401 | Thiếu/sai `x-api-key` khi bật auth |

---

## 9. Tham chiếu code

- Router: `src/api/routes/hanoiRouter.ts`
- Worker: `src/providers/hanoi/EVNHanoiWorker.ts`
- Link thanh toán: `src/services/hanoi/hanoiOnlinePaymentLink.ts`
- Webhook: `src/services/webhook/agentTaskWebhook.ts`
