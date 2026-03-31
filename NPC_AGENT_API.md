# NPC API (Agent Gateway — tích hợp nhanh)

Tài liệu đầy đủ và đồng bộ phiên bản với code nằm trong:

- **`docs_autocheckenv/agent-gateway-api-catalog.md`** — bảng endpoint + mô tả
- **`docs_autocheckenv/agent-gateway-api-catalog.json`** — catalog máy đọc (id, tags, body)
- **`docs_autocheckenv/openapi.yaml`** — OpenAPI 3.0 (import gateway / codegen)
- **`docs_autocheckenv/evn-autocheck-integration-constraints.md`** — ràng buộc provider CPC vs NPC, auth, trùng task
- **`docs_autocheckenv/agent-gateway-npc-gtgt-contract.md`** — hợp đồng tích hợp **NPC: thông báo + HĐ GTGT** (truy vấn, PDF, Excel, hạn chế)
- **`AGENT_GATEWAY_TASK_WEBHOOK.md`** (repo root) — **webhook** khi task SUCCESS/FAILED (POST JSON, chữ ký HMAC, payload `task.finished`) — tích hợp Agent Gateway chủ động nhận kết quả

Header phiên bản (mọi response): `X-API-Version`, `X-Catalog-Version`, `X-Constraints-Doc-Version` — so khớp với `src/api/contract.ts`.

---

## Endpoint NPC (tóm tắt)

Base URL: `http(s)://<host>:<API_PORT>` — Auth (nếu bật): `x-api-key: <API_KEY>`

| Method | Path | Body / query |
|--------|------|----------------|
| `POST` | `/api/npc/accounts` | JSON `{ username, password, label? }` — server cần `NPC_CREDENTIALS_SECRET` |
| `GET` | `/api/npc/accounts` | `?enabledOnly=true&limit=&skip=` |
| `PATCH` | `/api/npc/accounts/:id` | JSON `{ enabled: boolean }` |
| `POST` | `/api/npc/tasks` | JSON `{ npcAccountId, ky, thang, nam }` hoặc `period`/`month`/`year` |
| `POST` | `/api/npc/accounts/replace-bulk` | Xóa hết `npc_accounts` + nạp JSON — cần `NPC_ALLOW_ACCOUNT_REPLACE_BULK=true` và `confirmation: "DELETE_ALL_NPC_ACCOUNTS"` |

Task tạo ra có `provider: "EVN_NPC"` trong collection `scrape_tasks`. Theo dõi qua `GET /api/tasks/:taskId` như task CPC.

### Thay toàn bộ user từ Excel (CLI)

```bash
npm run replace:npc-accounts:xlsx -- path/to/accounts.xlsx --confirm-delete-all
```

Đọc file trước; chỉ khi có ít nhất một dòng hợp lệ mới xóa DB rồi insert. Cột A = username, B = password (giống `import:npc-accounts:xlsx`).

---

## Discovery

`GET /` trả JSON có nhóm `endpoints.npc` và `catalogReference` trỏ tới các file trong `docs_autocheckenv/`.
