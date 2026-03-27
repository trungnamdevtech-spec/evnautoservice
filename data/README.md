# Thư mục `data/` — tài khoản NPC (Excel)

- Đặt file **`.xlsx`** (Excel 2007+) tại đây để import vào MongoDB (`npc_accounts`).
- **Định dạng:** sheet đầu (hoặc chỉ định `--sheet=`), **cột A = username**, **cột B = password** (mật khẩu được mã hóa khi lưu — cần `NPC_CREDENTIALS_SECRET`).
- Tên file mặc định khi bật import lúc khởi động: **`npc-accounts.xlsx`** (xem `NPC_ACCOUNTS_XLSX_PATH` trong `.env`).

**Import thủ công (một lần):**

```bash
npm run import:npc-accounts:xlsx -- data/npc-accounts.xlsx
```

**Import khi khởi động app:** trong `.env` đặt `AUTO_IMPORT_NPC_XLSX=true` và file tồn tại tại đường dẫn trên (Docker: mount `./data:/app/data` trong `docker-compose.yml`).

**Không commit** file `.xlsx` chứa mật khẩu thật lên Git (đã ignore trong `.gitignore`).
