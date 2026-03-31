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
| `provider` | `"EVN_CPC"` \| `"EVN_NPC"` | Nguồn task. |
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

## 6. Checklist tích hợp Gateway

1. **Endpoint** POST nhận raw body, verify `X-Agent-Task-Signature` nếu có secret.
2. **Parse JSON** sau verify; đọc `taskId`, `status`, `provider`.
3. **Định tuyến nội bộ** theo `payload` (vd. `kind === "online_payment_link"` → luồng “link thanh toán”).
4. **SUCCESS + `onlinePaymentLink`:** đọc `ok` / `code` — không nhầm “không có link” với lỗi hệ thống.
5. **FAILED:** hiển thị / escalate theo `errorMessage` (có thể rất dài).
6. **Trả HTTP 2xx** nhanh (xử lý nặng nề đưa queue nội bộ) để tránh timeout phía AutoCheck.

---

## 7. Liên quan code

- Gửi webhook: `src/services/webhook/agentTaskWebhook.ts`
- Worker: mọi kết thúc task đi qua `completeTaskSuccess` / `completeTaskFailed` trong `src/worker/processTask.ts` (cặp **mark DB + webhook** — tránh lệch nhánh như thiếu webhook ở `online_payment_link`).
- Biến môi trường: `src/config/env.ts`

Tài liệu poll task / API: `GET /api/tasks/:taskId` trong catalog Agent Gateway.
