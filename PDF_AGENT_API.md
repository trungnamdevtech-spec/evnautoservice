# PDF API Contract (Agent Integration)

Tai lieu ngan cho agent khi can lay file PDF hoa don da duoc tai ve trong he thong.

Base URL: `http://<host>:1371` (hoac domain public cua ban)  
Auth (neu bat): header `x-api-key: <API_KEY>`

## 1) Tai PDF theo invoiceId

- Method: `GET`
- Path: `/api/pdf/invoice/:invoiceId`
- Query:
  - `fileType` (optional): `TBAO` (default) | `HDON`

Vi du:
- `GET /api/pdf/invoice/1591530428`
- `GET /api/pdf/invoice/1591530428?fileType=HDON`

Ket qua:
- `200 application/pdf` (body la file PDF)
- `404` neu khong tim thay PDF trong DB
- `500` neu DB co metadata nhung file tren disk khong doc duoc

## 2) Tai PDF moi nhat theo maKhachHang

- Method: `GET`
- Path: `/api/pdf/customer/:maKhachHang/latest`
- Query:
  - `fileType` (optional): `TBAO` (default) | `HDON`
  - `ky` (optional): `1|2|3`
  - `thang` (optional): `1..12`
  - `nam` (optional): `2026`

Vi du:
- `GET /api/pdf/customer/PA22040530046/latest`
- `GET /api/pdf/customer/PA22040530046/latest?fileType=TBAO&thang=2&nam=2026`

Ket qua:
- `200 application/pdf`
- `404` neu khong co ban ghi phu hop filter

## 3) Liet ke metadata PDF de agent lua chon file

- Method: `GET`
- Path: `/api/pdf/customer/:maKhachHang/list`
- Query:
  - `fileType` (optional): `TBAO` (default) | `HDON`
  - `limit` (optional): `1..200`, mac dinh `20`

Vi du:
- `GET /api/pdf/customer/PA22040530046/list?limit=10`

Response `200` (JSON):
- `maKhachHang`, `fileType`, `total`
- `data[]`:
  - `invoiceId`
  - `ky`, `thang`, `nam`
  - `ngayPhatHanh`
  - `bytes`, `downloadedAt`
  - `filePath` (path tuong doi)
  - `downloadUrl` (goi lai endpoint invoice de lay file)
  - `zipUrl` (goi ZIP tat ca file trong pham vi list — cung `fileType` + `limit`)

## 4) ZIP nhieu PDF theo ma khach hang

- Method: `GET`
- Path: `/api/pdf/customer/:maKhachHang/zip`
- Query:
  - `fileType` (optional): `TBAO` (default) | `HDON`
  - `ky`, `thang`, `nam` (optional): loc giong `/latest` — khong truyen thi lay tat ca trong gioi han `limit`
  - `limit` (optional): `1..2000`, mac dinh `500` (so hoa don toi da dua vao ZIP)

Vi du:
- `GET /api/pdf/customer/PA22040530046/zip?fileType=TBAO&thang=2&nam=2026&limit=200`
- `GET /api/pdf/customer/PA22040530046/zip`

Ket qua:
- `200 application/zip` (attachment; ten file trong ZIP: `MA_KHANG_ID_HDON_fileType.pdf` — dung `pdfEntryFileName` trong code)
- `404` neu khong co ban ghi PDF OK trong DB theo filter
- `500` neu DB co metadata nhung khong doc duoc file tren disk

## 5) ZIP tat ca PDF trong mot ky thang nam (moi KH)

- Method: `GET`
- Path: `/api/pdf/period/zip`
- Query (bat buoc):
  - `ky`: `1|2|3`
  - `thang`: `1..12`
  - `nam`: `2026`
- Query (optional):
  - `fileType`: `TBAO` (default) | `HDON`
  - `limit`: `1..2000`, mac dinh `500`

Vi du:
- `GET /api/pdf/period/zip?ky=1&thang=2&nam=2026&fileType=TBAO&limit=500`

Ket qua: giong muc 4 (ZIP stream).

## Tai su dung trong code

- `src/services/pdf/pdfZipService.ts`: `pdfEntryFileName`, `filterExistingPdfRefs`, `buildPdfZipResponse` — worker/script khac nen import khi can dong goi PDF giong API.

## Error format

Tat ca loi tra JSON:

```json
{
  "error": "message",
  "detail": "optional"
}
```

