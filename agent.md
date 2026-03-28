# AGENT MAP - AutoCheck EVN (EVN CPC + NPC)

Tai lieu nay la ban do du an danh cho AI agent de:
- Xac dinh nhanh file nao chua logic nao.
- Di dung duong khi debug/sua loi/mo rong.
- Giam sai sot khi thao tac voi worker + API + MongoDB + Playwright.

---

## 1) Muc tieu he thong

He thong tu dong:
1. Nhan task tra cuu hoa don EVN CPC (ky/thang/nam).
2. Worker Playwright dang nhap + tra cuu danh sach hoa don.
3. Luu danh sach hoa don thô vao `invoice_items`.
4. Tai PDF thong bao (TBAO) cho tung hoa don.
5. Parse PDF -> du lieu chuan hoa `electricity_bills`.
6. Cung cap API de quan ly task, truy van bill, thong ke, export Excel, healthcheck.
7. (NPC) Quan ly tai khoan CSKH mien Bac (`npc_accounts`), task `EVN_NPC` — dang nhap + luu session (pipeline hoa don NPC mo rong sau).

Cong nghe chinh:
- Node.js + TypeScript (ESM, NodeNext).
- Playwright + playwright-extra stealth.
- Hono API server.
- MongoDB.

---

## 2) Entrypoint va luong chay tong

### Runtime chinh
- `src/index.ts`
  - Ket noi Mongo (`getMongoDb`).
  - Khoi dong API (`startApiServer`) non-blocking.
  - Khoi dong worker loop (`TaskRunner.startLoop`).

### Worker pipeline
- `src/worker/TaskRunner.ts`
  - Vong lap poll task.
  - Gioi han song song bang `WORKER_CONCURRENCY`.
- `src/worker/processTask.ts`
  - Claim task atomic (CPC + NPC).
  - Tao BrowserContext/Page cho task.
  - CPC: `EVNCPCWorker.runTask` + `autoParseNewPdfs`.
  - NPC: `processNpcTask` + `EVNNPCWorker.runTask`.
  - Mark `SUCCESS`/`FAILED`.

### Provider EVN CPC
- `src/providers/evn/EVNCPCWorker.ts`
  - Dang nhap hoac dung session.
  - Set ky/thang/nam tren form.
  - Giai captcha + submit.
  - Bat response danh sach hoa don.
  - Upsert `invoice_items`.
  - Tai PDF thong bao.

### Provider EVN NPC (CSKH NPC)
- `src/providers/npc/EVNNPCWorker.ts` — session tu `npc_accounts.storageStateJson`.
- `src/providers/npc/npcLogin.ts` — form AccountNPC, captcha (type 14).
- `src/providers/npc/npcSelectors.ts`, `npcTaskPayload.ts`.
- `src/db/npcAccountRepository.ts`, `src/services/crypto/npcCredentials.ts`.
- API: `src/api/routes/npcRouter.ts` (`/api/npc/accounts`, `/api/npc/tasks`).
- **Tai lieu Agent Gateway:** `docs_autocheckenv/agent-gateway-api-catalog.md`, `agent-gateway-api-catalog.json`, `openapi.yaml`, `evn-autocheck-integration-constraints.md`; tom tat: `NPC_AGENT_API.md`.

---

## 3) Kien truc thu muc (file -> chuc nang)

### `src/config`
- `env.ts`: parse bien moi truong, gom toan bo config runtime.

### `src/core`
- `BaseWorker.ts`: quan ly browser/session/context; flow captcha retry.
- `stepTimeout.ts`: helper timeout cho step.
- `logger.ts`: log level + `logTaskPhase`.

### `src/db`
- `mongo.ts`: singleton Mongo client.
- `taskRepository.ts`: CRUD task queue (`scrape_tasks`) — claim ca `EVN_CPC` va `EVN_NPC`.
- `npcAccountRepository.ts`: tai khoan NPC (`npc_accounts`).
- `invoiceItemRepository.ts`: upsert danh sach invoice + status tai PDF.
- `electricityBillRepository.ts`: upsert/truy van bill da parse; loc theo miền: `electricityBillRegionScope.ts`.

### `src/providers/evn`
- `EVNCPCWorker.ts`: pipeline EVN CPC end-to-end.
- `evnCpcLogin.ts`: login form + check API `check-exist-user`.
- `checkExistUserApi.ts`: parse/validate response login.
- `evnCpcInvoiceForm.ts`: set ky/thang/nam (react-select/ant-select/hidden input fallback).
- `evnCpcSelectors.ts`: selector tap trung.

### `src/services`
- `captcha/AnticaptchaClient.ts`: goi anticaptcha.top.
- `evn/EvnCpcPdfClient.ts`: goi API PDF CPC + save file.
- `pdf/ElectricityBillParser.ts`: parse text PDF -> `ElectricityBill`.
- `export/ExcelExportService.ts`: xuat Excel theo ky/thang/customer.

### `src/api`
- `server.ts`: tao app Hono, middleware, auth, route mounting.
- `contract.ts`: version contract/header/doc path.
- `routes/tasksRouter.ts`: tao/cancel/retry/list task.
- `routes/billsRouter.ts`: truy van bill theo customer/period/month/due-soon/invoiceId (**query `region` / `provider`** — xem `AGENT_REGION_API_UPDATE.md`).
- `routes/statsRouter.ts`: thong ke thang/ky/customer history (**region**).
- `routes/exportRouter.ts`: tai file Excel (**region**).
- `regionQuery.ts`: doc `region` hoac `provider` tu query string.
- `routes/healthRouter.ts`: health/db/data integrity.
- `routes/npcRouter.ts`: tai khoan NPC + tao task `EVN_NPC`.

### `src/types`
- `task.ts`: schema task + metadata ket qua (`provider`: `EVN_CPC` | `EVN_NPC`).
- `npcAccount.ts`: schema `npc_accounts`.
- `invoiceItem.ts`: schema du lieu hoa don thô + pdfDownloads.
- `electricityBill.ts`: schema bill da parse.

### `src/scripts` (operational/testing)
- `seed-pending-task.ts`: chen task PENDING.
- `run-one-task.ts`: xu ly 1 task roi thoat.
- `test-login.ts`: test login thu cong (dung/sai pass).
- `test-failed-login-db.ts`: tao task loi login de kiem thu FAILED path.
- `test-wrong-captcha.ts`: mock captcha sai de test retry.
- `parse-all-pdfs.ts`: parse lai toan bo PDF.

### Root runtime/deploy
- `package.json`: scripts + deps.
- `Dockerfile`: multi-stage build + runtime Playwright image.
- `docker-compose.yml`: stack `app + mongo`.
- `.env.example`: bien moi truong mau.

---

## 4) Data model va collection Mongo

### `scrape_tasks`
Nguon queue cho worker:
- Trang thai: `PENDING | RUNNING | SUCCESS | FAILED`.
- `provider`: `EVN_CPC` | `EVN_NPC`.
- `payload`: period/month/year; voi NPC them `npcAccountId` (ObjectId hex).
- `resultMetadata`: tong ket invoice sync, pdf sync, parse sync (CPC); NPC hien ghi nhan dang nhap + lookupPayload.

### `npc_accounts`
Tai khoan dang nhap CSKH NPC:
- `username` (unique), `passwordEncrypted`, `enabled`, `storageStateJson`, `lastLoginAt`, `label`.

### `invoice_items`
Du lieu hoa don lay tu API CPC:
- Key duy nhat: `ID_HDON`.
- Co `pdfDownloads.TBAO|HDON` de danh dau da tai/loi.
- Dung lam nguon de tai PDF va map metadata parse.

### `electricity_bills`
Du lieu da parse tu PDF (CPC + NPC):
- `provider`: `EVN_CPC` | `EVN_NPC` (ban ghi cu co the khong co field — coi la CPC khi loc miền).
- CPC: `invoiceId` / `billKey` cpc; NPC: `npcIdHdon`, `billKey` npc — khong tron khoa giua miền.
- `status`: `parsed | error | pending`.
- **API list/export/stats:** luôn truyền `region=EVN_CPC|EVN_NPC|all` khi tích hợp — chi tiết: `AGENT_REGION_API_UPDATE.md`.

---

## 5) Luong du lieu chi tiet (critical path)

1. API tao task: `POST /api/tasks` -> `TaskRepository.insertPendingEvn`.
2. `TaskRunner` claim task atomic: `claimNextPending`.
3. `processTask` mo browser session, tao context/page.
4. `EVNCPCWorker.runTask`:
   - Dang nhap (`evnCpcLogin.ts`) hoac dung `sessionData`.
   - Mo trang tra cuu + set ky/thang/nam.
   - Giai captcha (`BaseWorker.handleCaptchaWithRetry`).
   - Bat response `traCuuHDDTTheoMST`.
   - Upsert `invoice_items`.
   - Dung bearer token de tai PDF TBAO va mark ket qua.
5. Quay lai `processTask`:
   - `autoParseNewPdfs` parse file vua tai.
   - Upsert `electricity_bills` hoac mark parse error.
   - Mark task `SUCCESS/FAILED`.

**Luong NPC (tom tat):** `POST /api/npc/tasks` -> `insertPendingNpc` -> `processNpcTask` -> `EVNNPCWorker.runTask` (dang nhap + luu `storageStateJson`) -> `markSuccess` (chua parse PDF nhu CPC).

---

## 6) Bien moi truong quan trong (uu tien khi debug)

File nguon: `.env` (tham khao `.env.example`), parse tai `src/config/env.ts`.

Nhom DB/worker:
- `MONGODB_URI`, `MONGODB_DB`
- `WORKER_CONCURRENCY`, `TASK_POLL_INTERVAL_MS`

Nhom Playwright:
- `PLAYWRIGHT_HEADLESS`
- `PLAYWRIGHT_MOBILE_MODE`
- `PLAYWRIGHT_PAUSE_BEFORE_CLOSE_MS`

Nhom EVN auth/flow:
- `EVN_CPC_LOGIN_URL`
- `EVN_CPC_LOGIN_USERNAME`, `EVN_CPC_LOGIN_PASSWORD`
- `EVN_CPC_LOOKUP_URL`
- `EVN_CPC_CHECK_EXIST_USER_URL_MATCH`

Nhom captcha/PDF:
- `ANTICAPTCHA_API_KEY`, `ANTICAPTCHA_API_URL`, `ANTICAPTCHA_TYPE`, `ANTICAPTCHA_CASESENSITIVE`
- `EVN_CPC_API_BASE_URL`
- `PDF_OUTPUT_DIR`

Nhom API public:
- `API_PORT`
- `API_KEY_AUTH_ENABLED`, `API_KEY`
- `EVN_AUTOCHECK_BASE_URL`

Nhom NPC:
- `EVN_NPC_LOGIN_URL`, `EVN_NPC_HOME_URL`
- `NPC_CREDENTIALS_SECRET` (bat buoc khi API them tai khoan NPC)

---

## 7) API map can nho nhanh

Gateway root discovery:
- `GET /` (endpoint map + version headers)
- Tai lieu day du cho Agent Gateway: `docs_autocheckenv/agent-gateway-api-catalog.md`, `agent-gateway-api-catalog.json`, `openapi.yaml`, `evn-autocheck-integration-constraints.md`

Task (CPC):
- `POST /api/tasks`
- `GET /api/tasks`
- `GET /api/tasks/active`
- `GET /api/tasks/counts`
- `GET /api/tasks/:taskId`
- `POST /api/tasks/:taskId/cancel`
- `POST /api/tasks/:taskId/retry`

NPC (CSKH mien Bac):
- `POST /api/npc/accounts`
- `GET /api/npc/accounts`
- `PATCH /api/npc/accounts/:id`
- `POST /api/npc/tasks`

Bills:
- `GET /api/bills/customers`
- `GET /api/bills/customer/:maKH`
- `GET /api/bills/customer/:maKH/latest`
- `GET /api/bills/customer/:maKH/due-soon`
- `GET /api/bills/customer/:maKH/history`
- `GET /api/bills/period`
- `GET /api/bills/month`
- `GET /api/bills/due-soon`
- `GET /api/bills/:invoiceId`

Stats:
- `GET /api/stats/month`
- `GET /api/stats/period`
- `GET /api/stats/customer/:maKH/history`

Export:
- `GET /api/export/period`
- `GET /api/export/month`
- `GET /api/export/customer/:maKH`

Health:
- `GET /api/health`
- `GET /api/health/db`
- `GET /api/health/data-integrity`

---

## 8) "Tim o dau" theo tac vu (for AI agent)

Neu can sua login EVN:
- `src/providers/evn/evnCpcLogin.ts`
- `src/providers/evn/checkExistUserApi.ts`
- `src/providers/evn/evnCpcSelectors.ts`

Neu UI thay doi selector/form ky-thang-nam:
- `src/providers/evn/evnCpcInvoiceForm.ts`
- `src/providers/evn/evnCpcSelectors.ts`
- `src/providers/evn/EVNCPCWorker.ts` (verify request params)

Neu captcha loi:
- `src/core/BaseWorker.ts` (retry flow)
- `src/services/captcha/AnticaptchaClient.ts`

Neu tai PDF loi:
- `src/services/evn/EvnCpcPdfClient.ts`
- `src/providers/evn/EVNCPCWorker.ts` (bearer capture + loop download)
- `src/db/invoiceItemRepository.ts` (`markPdfDownloaded`)

Neu parse PDF sai:
- `src/services/pdf/ElectricityBillParser.ts`
- `src/types/electricityBill.ts`
- `src/db/electricityBillRepository.ts`

Neu task queue bi ket:
- `src/worker/TaskRunner.ts`
- `src/worker/processTask.ts`
- `src/db/taskRepository.ts`

Neu API response/validation sai:
- `src/api/routes/*.ts`
- `src/api/server.ts`
- `src/api/contract.ts`

Neu export Excel can doi format:
- `src/services/export/ExcelExportService.ts`
- `src/api/routes/exportRouter.ts`

---

## 9) Scripts van hanh nhanh

- Build: `npm run build`
- Chay app dev: `npm run dev`
- Chay API standalone: `npm run api`
- Seed task: `npm run seed:task` hoac `npm run seed:task:demo`
- Xu ly 1 task: `npm run test:e2e`
- Test login: `npm run test:login`
- Test login sai: `npm run test:login:wrong`
- Test FAILED path ghi DB: `npm run test:login:db`
- Test retry captcha sai: `npm run test:wrong-captcha`
- Parse lai PDF: `npm run parse:pdfs`
- Force parse lai: `npm run parse:pdfs:force`

---

## 10) Quy tac an toan khi AI agent sua code

1. Khong doi `types` ma khong soat lai `repository + routes + parser`.
2. Khong sua selector EVN ma khong test lai flow `setKyThangNam + captcha + collectInvoiceList`.
3. Neu sua parser:
   - tang `PARSER_VERSION`,
   - chay `parse:pdfs:force` tren mau du lieu.
4. Neu sua API contract:
   - dong bo `src/api/contract.ts`,
   - cap nhat `docs_autocheckenv/*` (catalog md/json, openapi, constraints) va `API_CATALOG_OPERATIONS_COUNT`,
   - dam bao root `GET /` va header version khong vo.
5. Neu sua worker concurrency/timeouts:
   - kiem tra race/claim duplicate va browser lifecycle (`begin/endBrowserSession`).
6. Khong commit secret (`.env`, API key, credential).

---

## 11) Trieu chung -> diem nghi ngo dau tien

- Task khong duoc nhan:
  - Kiem tra `scrape_tasks` co `PENDING`?
  - Kiem tra `TaskRunner.startLoop`, `WORKER_CONCURRENCY`, ket noi Mongo.

- Task RUNNING nhung khong ra ket qua:
  - Kiem tra timeout step trong `EVNCPCWorker`.
  - Kiem tra selector form/captcha.

- Login fail:
  - Kiem tra env user/pass.
  - Kiem tra parse response `check-exist-user`.

- Captcha lap vo han:
  - Kiem tra `ANTICAPTCHA_API_KEY`.
  - Kiem tra luong `shouldRetryCaptcha` trong `submit`.

- Co invoice nhung khong co bill parsed:
  - Kiem tra `pdfDownloads.TBAO`.
  - Kiem tra parser status `electricity_bills.status=error`.
  - Dung `GET /api/health/data-integrity`.

- Export ra file rong:
  - Kiem tra query period/month/customer trong `exportRouter`.
  - Kiem tra data `electricity_bills.status="parsed"`.

---

## 12) Ghi chu trien khai

- Docker runtime dung image Playwright co san Chromium.
- `docker-compose` ep app noi Mongo qua `mongodb://mongo:27017`.
- Mount `./output/pdfs:/app/output/pdfs` de luu file ben host.
- App co the bat API key auth toan cuc qua `API_KEY_AUTH_ENABLED=true`.

---

## 13) Checklist nhanh truoc khi ket luan "fix xong"

1. Build TypeScript thanh cong (`npm run build`).
2. API con respond `GET /api/health`.
3. Chay it nhat 1 flow worker thuc (`seed` + `test:e2e`) neu co sua worker/provider.
4. Neu sua parser -> parse duoc file mau va khong lam vo schema.
5. Khong tao thay doi secret/data local khong mong muon.

---

Tai lieu nay uu tien cho AI thao tac nhanh/chinh xac. Khi codebase doi, cap nhat lai `agent.md` dong bo voi cac file tren de tranh "ban do lech thuc te".
