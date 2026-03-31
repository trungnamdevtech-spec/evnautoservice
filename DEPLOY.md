# Checklist triển khai (máy chủ / Docker)

0. **Cài dependency (bắt buộc sau `git pull`):** trong thư mục repo chạy `npm ci` hoặc `npm install`.  
   - **Không** dùng `npm ci --omit=dev` trừ khi bạn chỉ chạy file đã build sẵn trong `dist/` và không chạy script `.ts` (import xlsx, replace accounts, …).  
   - Nếu gặp `tsc: command not found` hoặc `Cannot find package 'tsx'`: chạy lại **`npm install`** đầy đủ (hoặc `npm ci --include=dev`), rồi `npm run build`.

1. **`.env`** (tham chiếu biến trong repo / tài liệu nội bộ): `MONGODB_URI`, `MONGODB_DB`, `NPC_CREDENTIALS_SECRET` (≥16 ký tự), `ANTICAPTCHA_API_KEY`, `API_KEY`, `API_KEY_AUTH_ENABLED`, `EVN_CPC_LOGIN_*` nếu dùng quét CPC.
2. **MongoDB:** `docker compose up -d` — service `mongo` healthy trước `app`.
3. **NPC — tài khoản:** đặt `data/npc-accounts.xlsx` (cột A/B) hoặc chạy `npm run import:npc-accounts:xlsx -- data/...xlsx` một lần; hoặc `AUTO_IMPORT_NPC_XLSX=true` để import khi start.
4. **Volume:** `output/pdfs` và `data` đã map trong `docker-compose.yml` — đảm bảo quyền ghi trên host.
5. **Cổng:** mở `API_PORT` (mặc định 1371) nếu Agent Gateway gọi từ ngoài.
6. **Worker:** `WORKER_CONCURRENCY`, `TASK_POLL_INTERVAL_MS` — tăng `shm_size` nếu nhiều task Playwright.
7. **Sau deploy:** `GET /api/health`, `GET /api/health/db`; thử `POST /api/npc/tasks` hoặc `enqueue-all-enabled` với kỳ thử.

Phiên bản API: header `X-API-Version` / `src/api/contract.ts`.
