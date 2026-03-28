# Agent integration — phân miền dữ liệu (CPC vs NPC)

Tài liệu này bổ sung cho `agent.md`: mô tả **hợp đồng API** và **ràng buộc dữ liệu** sau khi hệ thống tách truy vấn `electricity_bills` theo miền. Agent / gateway / client gọi API **phải** truyền đúng `region` (hoặc `provider`) để không nhầm lẫn giữa Điện lực CPC và NPC.

---

## 1) Vì sao cần

- Collection `electricity_bills` lưu hóa đơn đã parse từ **cả hai nguồn**: portal CPC và CSKH NPC.
- Trước đây một số endpoint list/export/stats **không lọc `provider`** → có thể **trộn** CPC và NPC trong cùng một response.
- Hiện tại mọi truy vấn “theo danh sách / kỳ / tháng / khách hàng” đều đi qua **bộ lọc miền** (mặc định an toàn: chỉ CPC + bản ghi cũ không có `provider`).

---

## 2) Mô hình dữ liệu (MongoDB `electricity_bills`)

| Trường | Ý nghĩa |
|--------|---------|
| `provider` | `EVN_CPC` hoặc `EVN_NPC`. Bản ghi cũ có thể **không có** field → khi lọc miền CPC vẫn **tính** vào CPC. |
| NPC | Thường có `billKey` dạng `npc:...`, `npcIdHdon`. |
| CPC | `invoiceId` (ID_HDON), có thể có `billKey` dạng `cpc:...`. |

**Không** giả định `maKhachHang` trùng giữa hai miền là cùng một thực thể — luôn kết hợp với `provider` / `region` khi tra cứu nghiệp vụ.

---

## 3) Tham số HTTP: `region` hoặc `provider`

- **Tên:** ưu tiên query **`region`**. Có thể dùng **`provider`** với **cùng giá trị** (alias).
- **Giá trị hợp lệ:**

| Giá trị | Hành vi |
|---------|---------|
| `EVN_CPC` | (mặc định nếu không truyền) Chỉ CPC + bản ghi **không có** `provider`. |
| `EVN_NPC` | Chỉ `provider: EVN_NPC`. |
| `all` (hoặc `mixed`, `*`) | **Không** lọc miền — trộn toàn bộ; chỉ dùng khi thống kê tổng hợp có chủ đích. |
| `NPC` | Chuẩn hóa thành `EVN_NPC`. |

- Response JSON của các route đã cập nhật thường có thêm field **`region`** để client đối chiếu phạm vi đã áp dụng.

---

## 4) Endpoint áp dụng (cần truyền `region` khi không muốn mặc định CPC)

**Prefix giả định:** `GET /api/...` (cùng base URL AutoCheck, có thể có `x-api-key` nếu bật auth).

| Nhóm | Endpoint | Ghi chú |
|------|----------|---------|
| Bills | `GET /bills/customers` | Danh sách mã KH (theo miền). |
| | `GET /bills/customer/:maKH` | Lịch sử HĐ. |
| | `GET /bills/customer/:maKH/latest` | HĐ mới nhất. |
| | `GET /bills/customer/:maKH/due-soon` | Sắp đến hạn. |
| | `GET /bills/customer/:maKH/history` | Lịch sử tiêu thụ. |
| | `GET /bills/period?ky=&thang=&nam=` | Toàn bộ HĐ một kỳ. |
| | `GET /bills/month?thang=&nam=` | Toàn bộ HĐ một tháng. |
| | `GET /bills/due-soon` | HĐ sắp đến hạn (toàn DB theo miền). |
| Export | `GET /export/period`, `/export/month`, `/export/customer/:maKH` | File Excel — tên file có tiền tố miền. |
| Stats | `GET /stats/month`, `/stats/period`, `/stats/customer/:maKH/history` | Thống kê theo miền. |

**Ví dụ chỉ NPC:**

```http
GET /api/bills/period?ky=1&thang=2&nam=2026&region=EVN_NPC
```

**Ví dụ mặc định (CPC + legacy):**

```http
GET /api/bills/period?ky=1&thang=2&nam=2026
```

---

## 5) Route **không** dùng `region` query (đã gắn NPC sẵn)

- `GET /api/npc/bills?maKhachHang=&limit=` — luôn `provider: EVN_NPC` trong code.
- `GET /api/pdf/npc/...` — PDF / list NPC.
- `GET /api/bills/npc/:idHdon` — tra theo `id_hdon` NPC.
- `GET /api/bills/:invoiceId` — tra theo **CPC** `ID_HDON` (`findById` loại trừ NPC).

Agent ưu tiên route `/api/npc/...` cho luồng NPC-only để tránh nhầm.

---

## 6) Chỗ sửa code trong repo (khi mở rộng)

| File | Vai trò |
|------|---------|
| `src/db/electricityBillRegionScope.ts` | Định nghĩa `ElectricityBillRegionScope`, `parseRegionScopeFromQuery`, `mergeFilterWithRegion`. |
| `src/db/electricityBillRepository.ts` | `find()`, `findByPeriod`, `findByMonth`, aggregate, list customers, v.v. — tham số miền. |
| `src/api/regionQuery.ts` | `getRegionFromQuery(c)` — đọc query Hono. |
| `src/api/routes/billsRouter.ts`, `exportRouter.ts`, `statsRouter.ts` | Gắn `region` vào response và gọi repo. |

Khi thêm endpoint mới trả nhiều bản ghi từ `electricity_bills`: **bắt buộc** áp dụng cùng quy ước `region` (dùng `getRegionFromQuery` + `mergeFilterWithRegion` hoặc `BillQueryOptions.regionScope`).

---

## 7) `invoice_items`

- Chỉ phục vụ luồng **CPC** (danh sách từ API tra cứu CPC).
- **Không** trộn với NPC ở collection này. Agent không cần `region` cho `invoice_items` trừ khi sau này schema mở rộng.

---

## 8) Kiểm tra nhanh (review logic đã xác nhận)

- Mặc định thiếu `region` → **EVN_CPC** (gồm legacy không `provider`) → **không** lẫn NPC.
- `region=all` → không thêm filter miền → trộn có chủ đích.
- `find({ provider: "EVN_NPC" })` (ví dụ từ `npcRouter`) vẫn chỉ trả NPC.
- `parseRegionScopeFromQuery`: dùng `region?.trim() \|\| provider?.trim()` để `region=` rỗng vẫn đọc được `provider=EVN_NPC`.

---

## 9) Checklist tích hợp cho agent

1. Gọi list/export/stats theo **NPC** → luôn có `region=EVN_NPC` hoặc dùng route `/api/npc/...`.
2. Gọi theo **CPC** → có thể bỏ query (mặc định) hoặc ghi rõ `region=EVN_CPC`.
3. Không giả định một `maKhachHang` trên response mixed là “một khách” nếu không truyền `region=all` có mục đích rõ.
4. Đọc field `region` trong JSON response để xác nhận phạm vi đã áp dụng.

---

*Cập nhật đồng bộ với `agent.md` (mục DB + API). Khi đổi hợp đồng API, sửa file này và `src/api/server.ts` (mô tả route discovery).*
