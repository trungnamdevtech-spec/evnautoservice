# Agent Gateway — Webhook kết quả task (AutoCheck)

Khi worker AutoCheck ghi **SUCCESS** hoặc **FAILED** cho một task (`scrape_tasks`), có thể **POST** JSON tới URL do Agent Gateway cung cấp — **bổ sung** cho luồng poll `GET /api/tasks/:taskId` (không thay thế hoàn toàn nếu cần độ tin cậy tuyệt đối: webhook có thể lỗi mạng; AutoCheck **không** retry webhook).

---

## 1. Bật phía AutoCheck (server)

Trong `.env` của container / process chạy worker:

| Biến | Bắt buộc | Mô tả |
|------|----------|--------|
| `AGENT_TASK_WEBHOOK_URL` | Có (để bật) | URL HTTPS của Agent Gateway nhận POST (ví dụ `https://gateway.example.com/internal/autocheck/task-webhook`). Để trống = tắt webhook. |
| `AGENT_TASK_WEBHOOK_SECRET` | Không | Chuỗi bí mật dùng chung hai bên để ký HMAC-SHA256 **raw body** (UTF-8). Không đặt = không gửi header chữ ký. |
| `AGENT_TASK_WEBHOOK_TIMEOUT_MS` | Không | Timeout mỗi lần gọi (mặc định `15000`). |

Sau khi đổi `.env`: rebuild/restart stack (ví dụ `docker compose up -d --build`).

---

## 2. Request từ AutoCheck

- **Method:** `POST`
- **Content-Type:** `application/json`
- **Body:** UTF-8 JSON, **chuỗi serial hóa ổn định** (gateway verify chữ ký trên **byte-for-byte** giống body nhận được — không reformat JSON trước khi verify).

### Headers

| Header | Khi nào |
|--------|---------|
| `User-Agent` | `EVN-AutoCheck-Worker/1` |
| `X-Agent-Task-Signature` | Chỉ khi có `AGENT_TASK_WEBHOOK_SECRET`. Giá trị: `sha256=` + **hex** (64 ký tự) của HMAC-SHA256. |

### Thuật toán chữ ký (gateway phải khớp)

1. Lấy raw body dạng string (buffer UTF-8) như Express/Node nhận **trước** `JSON.parse`.
2. `expectedHex = HMAC_SHA256(secret, rawBody)` (hex lowercase, 64 ký tự).
3. So sánh `header` với chuỗi `sha256=` + `expectedHex` (constant-time nếu có thể).

Ví dụ Node (Express `rawBody`):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyAgentTaskSignature(rawBodyBuffer, headerValue, secret) {
  if (!secret || !headerValue?.startsWith("sha256=")) return true; // không bật secret thì không verify
  const hex = headerValue.slice("sha256=".length);
  const expected = createHmac("sha256", secret).update(rawBodyBuffer).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(hex, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
```

---

## 3. Body JSON (`AgentTaskWebhookPayload`)

| Field | Kiểu | Mô tả |
|-------|------|--------|
| `event` | `"task.finished"` | Cố định. |
| `taskId` | string | ObjectId hex `scrape_tasks._id`. |
| `provider` | `"EVN_CPC"` \| `"EVN_NPC"` \| `"EVN_HANOI"` | Nguồn task. |
| `status` | `"SUCCESS"` \| `"FAILED"` | Trạng thái cuối. |
| `payload` | object | Giống `payload` task trong DB (kỳ tháng năm, `npcAccountId`, `kind: "online_payment_link"`, …). |
| `resultMetadata` | object \| null | **Chỉ khi `status === "SUCCESS"`** — cùng cấu trúc `GET /api/tasks/:taskId` → `resultMetadata`. Khi FAILED thì `null`. |
| `errorMessage` | string \| null | **Chỉ khi `status === "FAILED"`** — thông báo lỗi (stack/message, có thể cắt độ dài). Khi SUCCESS thì `null`. |
| `completedAt` | string | ISO 8601 UTC. |

### NPC — `online_payment_link` (SUCCESS)

Trong `resultMetadata.lookupPayload.onlinePaymentLink` (khi `payload.kind === "online_payment_link"` trong `payload`):

- `ok: true` + `paymentUrl` — có link thanh toán.
- `ok: false` + `code` (vd. `NO_PAYMENT_LINK_IN_HTML`) — **vẫn là SUCCESS** ở task; nghiệp vụ không có URL (không đồng nghĩa lỗi hạ tầng).

Gateway nên map sang câu trả lời người dùng theo `code` / `reason` (xem tài liệu nghiệp vụ NPC).

---

## 4. Hành vi & ràng buộc

- **At-least-once:** AutoCheck gửi **một lần** POST sau khi ghi DB. Không có retry tự động.
- **Idempotency:** `taskId` là khóa ổn định — gateway có thể lưu `taskId` đã xử lý để tránh xử lý trùng nếu tương lai có gửi lại (hiện không có).
- **HTTP response:** AutoCheck coi **2xx** là gửi thành công; 4xx/5xx chỉ log phía worker, **không** làm task lỗi.
- **Poll vẫn hợp lệ:** Gateway có thể vừa nhận webhook vừa giữ `GET /api/tasks/:taskId` làm dự phòng.

---

## 5. Ví dụ payload

**SUCCESS (NPC, link thanh toán online — nghiệp vụ không có URL):**

```json
{
  "event": "task.finished",
  "taskId": "69cbef4e616ba7165139a8c3",
  "provider": "EVN_NPC",
  "status": "SUCCESS",
  "payload": {
    "kind": "online_payment_link",
    "npcAccountId": "69cbeef0b2829b7646f783a7",
    "maKhachHang": "PA25BX0026156"
  },
  "resultMetadata": {
    "downloadedAt": "2026-03-31T12:00:00.000Z",
    "lookupPayload": {
      "onlinePaymentLink": {
        "ok": false,
        "code": "NO_PAYMENT_LINK_IN_HTML",
        "reason": "Không tìm thấy link thanh toán ...",
        "maKhachHang": "PA25BX0026156",
        "httpStatus": 200
      }
    }
  },
  "errorMessage": null,
  "completedAt": "2026-03-31T12:00:00.000Z"
}
```

**FAILED (lỗi kỹ thuật / exception):**

```json
{
  "event": "task.finished",
  "taskId": "...",
  "provider": "EVN_NPC",
  "status": "FAILED",
  "payload": { ... },
  "resultMetadata": null,
  "errorMessage": "Error: ...",
  "completedAt": "2026-03-31T12:00:00.000Z"
}
```

---

## 6. Sự kiện `hanoi.ensure_bill` (không đi qua `task.finished`)

Cùng **URL** `AGENT_TASK_WEBHOOK_URL`, cùng header **`X-Agent-Task-Signature`** (HMAC-SHA256 trên **raw body** UTF-8), cùng `User-Agent`. Được gửi **ngay** khi Agent gọi **`POST /api/hanoi/ensure-bill`** và API trả:

- **`outcome: cache_hit`** — đã có hóa đơn parse trong DB (không tạo task).
- **`outcome: already_queued`** — chưa có trong DB nhưng đã có task `PENDING`/`RUNNING` cùng tài khoản + cùng kỳ.

**Không gửi** sự kiện này khi `outcome: queued` (task mới tạo) — lúc đó chỉ có **`task.finished`** sau khi worker xong (như mọi task khác).

### 6.1. Khác biệt với `evn_task_callbacks` / map `chat_id`

- Payload **`hanoi.ensure_bill` không chứa `chat_id`** và **không chứa `taskId`** ở nhánh `cache_hit` (`taskId` luôn `null`).
- Gateway **không** thể map bằng “taskId → chat” cho **cache_hit** trừ khi đã lưu **khóa tương quan phía Gateway** lúc user yêu cầu (trước khi gọi AutoCheck).

**Đề xuất map Telegram / chat (phía Gateway):**

| Cách | Mô tả |
|------|--------|
| **Khóa tự nhiên** | Lưu khi nhận yêu cầu từ user: `(maKhachHang, ky, thang, nam)` (và optional `hanoiAccountId` nếu có) → `chat_id`. Khi nhận webhook, so khớp `maKhachHang` + `period` để gửi tin nhắn. |
| **already_queued** | `taskId` **khác null** — nếu Gateway đã ghi `taskId` vào `evn_task_callbacks` (hoặc bảng tương đương) khi tạo/poll task trước đó, có thể map `taskId` → `chat_id`. |
| **Mở rộng sau (không có trong bản hiện tại)** | AutoCheck có thể thêm field tùy chọn `correlationId` / `agentRequestId` trên `POST /api/hanoi/ensure-bill` và echo lại trong webhook — cần thay đổi API + server. |

### 6.2. Bảng field (`HanoiEnsureBillWebhookPayload`)

| Field | Kiểu | Bắt buộc | Mô tả |
|-------|------|----------|--------|
| `event` | `"hanoi.ensure_bill"` | Có | Phân biệt với `task.finished`. |
| `outcome` | `"cache_hit"` \| `"already_queued"` | Có | |
| `provider` | `"EVN_HANOI"` | Có | Cố định. |
| `maKhachHang` | string | Có | MA_KH đã chuẩn hoá (uppercase). |
| `hanoiAccountId` | string \| **null** | Có | ObjectId hex nếu resolve được tài khoản; **null** nếu chỉ có `maKhachHang` cache hit mà chưa gắn account. |
| `period` | `{ ky, thang, nam }` | Có | `ky` ∈ {1,2,3}. |
| `dataSource` | `"database"` \| `"task_queue"` | Có | `database` = cache_hit; `task_queue` = already_queued. |
| `taskId` | string \| **null** | Có | Task đang chờ — **chỉ khác null khi** `already_queued`; **luôn null** khi `cache_hit`. |
| `billInvoiceId` | number \| **null** | Có | `electricity_bills.invoiceId` khi cache_hit (bản tiền điện ưu tiên); **null** khi already_queued. |
| `completedAt` | string | Có | ISO 8601 UTC. |

### 6.3. Ví dụ JSON — `cache_hit`

```json
{
  "event": "hanoi.ensure_bill",
  "outcome": "cache_hit",
  "provider": "EVN_HANOI",
  "maKhachHang": "PD12000088258",
  "hanoiAccountId": "69cdf209bbda8aa950cbc97a",
  "period": { "ky": 2, "thang": 3, "nam": 2026 },
  "dataSource": "database",
  "taskId": null,
  "billInvoiceId": 1427750540,
  "completedAt": "2026-04-02T10:30:00.000Z"
}
```

### 6.4. Ví dụ JSON — `already_queued`

```json
{
  "event": "hanoi.ensure_bill",
  "outcome": "already_queued",
  "provider": "EVN_HANOI",
  "maKhachHang": "PD12000088258",
  "hanoiAccountId": "69cdf209bbda8aa950cbc97a",
  "period": { "ky": 2, "thang": 3, "nam": 2026 },
  "dataSource": "task_queue",
  "taskId": "69ce430b17529f4810ab2f8d",
  "billInvoiceId": null,
  "completedAt": "2026-04-02T10:31:00.000Z"
}
```

### 6.5. Handler gợi ý (Gateway)

```text
if (body.event === "task.finished") { … xử lý hiện tại … }
else if (body.event === "hanoi.ensure_bill") {
  // Map chat: ưu tiên (maKhachHang + period) đã lưu lúc user gọi ensure-bill;
  // hoặc taskId nếu outcome === "already_queued" && đã có map taskId → chat.
  // Gửi Telegram: thông báo đã có bill / đang xử lý, kèm billInvoiceId hoặc hướng dẫn poll GET /api/tasks/:taskId
}
```

---

## 7. Checklist tích hợp Gateway

1. **Endpoint** POST nhận raw body, verify `X-Agent-Task-Signature` nếu có secret.
2. **Parse JSON** sau verify; đọc **`event`** trước — `task.finished` vs `hanoi.ensure_bill` (handler khác nhau; mục 6).
3. Với **`task.finished`:** đọc `taskId`, `status`, `provider`.
4. Với **`hanoi.ensure_bill`:** map `chat_id` theo mục **6.1** (không có `taskId` khi `cache_hit`).
5. **Định tuyến nội bộ** theo `payload` (vd. `kind === "online_payment_link"` → luồng “link thanh toán”) — chỉ áp dụng `task.finished`.
6. **SUCCESS + `onlinePaymentLink`:** đọc `ok` / `code` — không nhầm “không có link” với lỗi hệ thống.
7. **FAILED:** hiển thị / escalate theo `errorMessage` (có thể rất dài).
8. **Trả HTTP 2xx** nhanh (xử lý nặng nề đưa queue nội bộ) để tránh timeout phía AutoCheck.

---

## 8. Liên quan code

- Gửi webhook: `src/services/webhook/agentTaskWebhook.ts` (`fireAgentTaskWebhook`, `fireHanoiEnsureBillWebhook`)
- Worker: mọi kết thúc task đi qua `completeTaskSuccess` / `completeTaskFailed` trong `src/worker/processTask.ts` (cặp **mark DB + webhook** — tránh lệch nhánh như thiếu webhook ở `online_payment_link`).
- Biến môi trường: `src/config/env.ts`

Tài liệu poll task / API: `GET /api/tasks/:taskId` trong catalog Agent Gateway.
