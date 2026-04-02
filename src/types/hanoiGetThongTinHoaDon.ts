/**
 * Phản hồi GET `/api/TraCuu/GetThongTinHoaDon` (evnhanoi.vn) — Bearer token.
 *
 * **`data.dmThongTinHoaDonList`**: danh sách các **kỳ ghi chỉ số / hóa đơn** trong **cùng tháng–năm**
 * cho cặp `(maDonViQuanLy, maKhang)`. Một tháng có **tối đa 3 kỳ**, **ít nhất 1 kỳ** (`ky` ∈ {1,2,3}).
 * Cùng lúc có thể xuất hiện nhiều dòng (ví dụ `ky: 1` và `ky: 2`) — dùng `distinctKyInRows` để biết tháng đó có mấy kỳ.
 *
 * Mỗi dòng có **`idHdon`** — tham số gửi sang `XemHoaDonByMaKhachHang` để lấy PDF:
 * một kỳ thường tải **hai** loại: thông báo / tiền điện (`loaiHdon` TD) và hóa đơn GTGT (theo cấu hình `HANOI_PDF_LOAI_*`).
 */
export interface HanoiDmThongTinHoaDonItem {
  maDonViQuanLy: string;
  /** Khóa tra cứu + tải PDF (Cmis) — mỗi kỳ một `idHdon`. */
  idHdon: number;
  maKhang: string;
  maKhtt: string;
  maSogcs: string;
  /** Kỳ trong tháng (1–3). Nhiều dòng cùng tháng/năm ⇒ nhiều kỳ. */
  ky: number;
  thang: number;
  nam: number;
  ngayDky: string;
  ngayCky: string;
  loaiHdon: string;
  loaiHdonName: string;
  /** Chuỗi dạng "245.717.760" */
  soTien: string;
  tienGtgt: string;
  tyleThue: number;
  tongTien: string;
  dienTthu: number;
  cosfi: number;
  kcosfi: number;
  kihieuSery: string;
  soSery: string;
  loaiDchinh: string;
  tienNo: number;
  thueNo: string;
  ttrangSsai: string;
  namCn: number;
  thangCn: number;
  ngayCn: number;
  ngayCapnhat: string;
  tt: number;
  isDaThanhToan: boolean;
}

export interface HanoiGetThongTinHoaDonData {
  /** Các dòng tra cứu theo kỳ; đếm `distinct ky` trong list ⇒ số kỳ có dữ liệu trong tháng (≤ 3). */
  dmThongTinHoaDonList?: HanoiDmThongTinHoaDonItem[];
}

export interface HanoiGetThongTinHoaDonResponse {
  isError?: boolean;
  message?: string | null;
  data?: HanoiGetThongTinHoaDonData;
  code?: number;
  errors?: unknown;
}
