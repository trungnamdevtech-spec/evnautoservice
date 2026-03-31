# Checklist triển khai (máy chủ / Docker)

## Docker (cách chạy chính trong repo)

- **`npm run build` trên máy chủ là không bắt buộc** khi bạn chỉ chạy stack bằng Compose. Lệnh `npm run build` đã chạy **bên trong `docker build`** (stage `build` trong `Dockerfile`), image runtime chỉ cần thư mục `dist/` đã biên dịch.
- Sau khi đổi code: `docker compose build` (hoặc `docker compose up -d --build`). Không cần cài Node trên host cho app — trừ khi bạn chủ động chạy script từ repo clone (xem mục dưới).

**Nạp lại / thay toàn bộ tài khoản NPC từ Excel trong container** (volume `./data` map vào `/app/data`):

```bash
docker compose exec app npm run replace:npc-accounts:clean:dist
```

Script `*:dist` dùng **`node dist/scripts/...`** (đã có trong image), **không** cần `src/` hay `tsx` trong container. Đặt `data/account_clean.xlsx` trên host trước khi chạy.

**Chạy Node trực tiếp trên máy chủ (không Docker):** khi đó mới cần `npm ci` / `npm install` và `npm run build` trong thư mục repo; dùng `npm run replace:npc-accounts:clean` (bản `.ts` + `tsx`) như tài liệu `data/README.md`.

**Nếu gặp `tsc` / `tsx` not found** khi chạy **ngoài** Docker: cài dependency đầy đủ (`npm install`) và đảm bảo `package.json`/`package-lock.json` đồng bộ (typescript/tsx nằm trong `dependencies`).

---

1. **`.env`** (tham chiếu biến trong repo / tài liệu nội bộ): `MONGODB_URI`, `MONGODB_DB`, `NPC_CREDENTIALS_SECRET` (≥16 ký tự), `ANTICAPTCHA_API_KEY`, `API_KEY`, `API_KEY_AUTH_ENABLED`, `EVN_CPC_LOGIN_*` nếu dùng quét CPC.
2. **MongoDB:** `docker compose up -d` — service `mongo` healthy trước `app`.
3. **NPC — tài khoản:** đặt `data/npc-accounts.xlsx` (cột A/B) hoặc chạy `docker compose exec app npm run replace:npc-accounts:clean:dist` / import tương ứng; hoặc `AUTO_IMPORT_NPC_XLSX=true` để import khi start.
4. **Volume:** `output/pdfs` và `data` đã map trong `docker-compose.yml` — đảm bảo quyền ghi trên host.
5. **Cổng:** mở `API_PORT` (mặc định 1371) nếu Agent Gateway gọi từ ngoài.
6. **Worker:** `WORKER_CONCURRENCY`, `TASK_POLL_INTERVAL_MS` — tăng `shm_size` nếu nhiều task Playwright.
7. **Sau deploy:** `GET /api/health`, `GET /api/health/db`; thử `POST /api/npc/tasks` hoặc `enqueue-all-enabled` với kỳ thử.

Phiên bản API: header `X-API-Version` / `src/api/contract.ts`.
