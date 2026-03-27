# NPC API (Agent Gateway — tích hợp nhanh)

Tài liệu đầy đủ và đồng bộ phiên bản với code nằm trong:

- **`docs_autocheckenv/agent-gateway-api-catalog.md`** — bảng endpoint + mô tả
- **`docs_autocheckenv/agent-gateway-api-catalog.json`** — catalog máy đọc (id, tags, body)
- **`docs_autocheckenv/openapi.yaml`** — OpenAPI 3.0 (import gateway / codegen)
- **`docs_autocheckenv/evn-autocheck-integration-constraints.md`** — ràng buộc provider CPC vs NPC, auth, trùng task

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

Task tạo ra có `provider: "EVN_NPC"` trong collection `scrape_tasks`. Theo dõi qua `GET /api/tasks/:taskId` như task CPC.

---

## Discovery

`GET /` trả JSON có nhóm `endpoints.npc` và `catalogReference` trỏ tới các file trong `docs_autocheckenv/`.
