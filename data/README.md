# Thư mục `data/` — tài khoản NPC (Excel)

- Đặt file **`.xlsx`** (Excel 2007+) tại đây để import vào MongoDB (`npc_accounts`).
- **Định dạng:** sheet đầu (hoặc chỉ định `--sheet=`), **cột A = username**, **cột B = password** (mật khẩu được mã hóa khi lưu — cần `NPC_CREDENTIALS_SECRET`).
- Tên file mặc định khi bật import lúc khởi động: **`npc-accounts.xlsx`** (xem `NPC_ACCOUNTS_XLSX_PATH` trong `.env`).

**Import thủ công (một lần):**

```bash
npm run import:npc-accounts:xlsx -- data/npc-accounts.xlsx
```

### Xóa hết user NPC rồi nạp lại file Excel mới (server / làm sạch)

Dùng khi muốn **thay toàn bộ** `npc_accounts` bằng bản clean (ví dụ `account_clean.xlsx`):

1. Đặt file `.xlsx` tại `data/account_clean.xlsx` (cột A = username, B = password).
2. Trên server (đã có `.env` với `MONGODB_URI`, `NPC_CREDENTIALS_SECRET`):

```bash
npm run replace:npc-accounts:clean
```

**Docker (image đã build, không có `src/`):** trong thư mục có `docker-compose.yml`:

```bash
docker compose exec app npm run replace:npc-accounts:clean:dist
```

Script này tương đương:

- Parse Excel — **chỉ khi có ít nhất một dòng hợp lệ** mới xóa DB (tránh làm trống nhầm).
- **`--wipe-npc-tasks`**: xóa mọi `scrape_tasks` có `provider: EVN_NPC` (task cũ trỏ `npcAccountId` cũ sẽ không còn hợp lệ).
- Xóa toàn bộ `npc_accounts` rồi insert lại từ file.

**Tuỳ chỉnh** (file/sheet khác, không xóa task):

```bash
npm run replace:npc-accounts:xlsx -- path/to/file.xlsx --confirm-delete-all
npm run replace:npc-accounts:xlsx -- data/account_clean.xlsx --confirm-delete-all --wipe-npc-tasks --sheet=Sheet1
```

**Lưu ý:** `invoice_items` / `electricity_bills` (theo mã KH) **không** bị xóa bởi lệnh này — chỉ reset tài khoản đăng nhập + hàng chờ task NPC. Nếu cần dọn dữ liệu bill theo chính sách riêng, xử lý thủ công hoặc script riêng.

**Import khi khởi động app:** trong `.env` đặt `AUTO_IMPORT_NPC_XLSX=true` và file tồn tại tại đường dẫn trên (Docker: mount `./data:/app/data` trong `docker-compose.yml`).

**Không commit** file `.xlsx` chứa mật khẩu thật lên Git (đã ignore trong `.gitignore`).
