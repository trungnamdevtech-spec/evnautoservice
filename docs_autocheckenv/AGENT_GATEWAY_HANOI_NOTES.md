# Ghi chú cho Agent Gateway — EVN Hà Nội (timing & UX)

Tài liệu nội bộ: đồng bộ hành vi **trợ lý chat** với hành vi **AutoCheck** khi gọi các luồng Hà Nội (đặc biệt **link thanh toán**, **ensure-bill**, poll task).

---

## 1. Thay đổi phía AutoCheck (server)

Phía server đã cấu hình **chờ trước khi gọi** API tra cứu nợ thanh toán và **retry** khi EVN trả HTTP 200 nhưng danh sách tạm rỗng (tránh báo “không có link” trong khi web vẫn có nợ).

Biến môi trường (tham chiếu `.env` production):

| Biến | Ý nghĩa ngắn |
|------|----------------|
| `HANOI_ONLINE_PAYMENT_TRACUU_PRE_DELAY_MS` | Thời gian chờ **trước lần đầu** POST `GetListThongTinNoKhachHang` (sau STS + đồng bộ hợp đồng trong worker). Giảm gọi API khi phiên EVN còn “nóng”. |
| `HANOI_ONLINE_PAYMENT_TRACUU_RETRY_DELAY_MS` | Cơ sở chờ **giữa các lần thử lại** khi cần retry. |
| `HANOI_ONLINE_PAYMENT_TRACUU_MAX_RETRIES` | Số lần **gọi thêm** sau lần đầu thất bại kiểu “list trống / thiếu URL” (tổng số lần HTTP = 1 + giá trị này). |

Giá trị triển khai hiện tại được đặt thẳng trong `.env` (không chỉ `.env.example`).

---

## 2. Quy tắc UX cho Agent (khuyến nghị): **6 giây**

EVN Hà Nội thường **phản hồi API khá nhanh**, nhưng luồng **async** (`POST` → **202** + `taskId` → poll / webhook) vẫn có khoảng trễ (worker + pre-delay + có thể retry).

**Khuyến nghị cho Gateway:**

1. Sau khi user gửi yêu cầu (ví dụ lấy link thanh toán Hà Nội), **đợi tối đa 6 giây** trước khi gửi thêm **một tin trấn an** kiểu *“Đang xử lý, anh/chị chờ chút…”*.
2. Nếu đã có kết quả **trước hoặc đúng trong 6 giây** (HTTP 200 ngay, hoặc poll/webhook xong) → **không cần** gửi thêm tin “đang xử lý” (tránh spam hai dòng cho cùng một ý).
3. Nếu **sau 6 giây** vẫn chưa có kết quả → gửi **một** tin trấn an, rồi tiếp tục poll / chờ webhook như hiện tại.

Con số **6 giây** là ngưỡng UX cho chat; không thay thế timeout kỹ thuật của HTTP client hay poll interval.

---

## 3. API liên quan (nhắc nhanh)

- `POST /api/hanoi/online-payment-link` — thường **202** + `taskId`; kết quả trong `GET /api/tasks/:taskId` → `resultMetadata.lookupPayload.onlinePaymentLink`.
- Webhook `task.finished` — xem `AGENT_GATEWAY_TASK_WEBHOOK.md` (repo root).
- Sự kiện `hanoi.ensure_bill` — khi cache hit / đã xếp hàng; xem cùng file webhook.

---

## 4. Liên hệ vận hành

Khi đổi `.env` (pre-delay / retry), cập nhật lại bảng mục 1 hoặc phiên bản triển khai để Gateway biết ngưỡng trễ thực tế có thể tăng nhẹ (ví dụ thêm vài giây nếu tăng `PRE_DELAY`).
