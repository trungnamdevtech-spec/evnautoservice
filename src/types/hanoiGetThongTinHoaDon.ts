/**
 * Phản hồi GET `/api/TraCuu/GetThongTinHoaDon` (evnhanoi.vn) — Bearer token.
 * Một tháng có thể có nhiều kỳ (ky 1, 2, …); mỗi dòng là một kỳ (tiền điện + GTGT trong cùng bản ghi).
 */
export interface HanoiDmThongTinHoaDonItem {
  maDonViQuanLy: string;
  idHdon: number;
  maKhang: string;
  maKhtt: string;
  maSogcs: string;
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
  dmThongTinHoaDonList?: HanoiDmThongTinHoaDonItem[];
}

export interface HanoiGetThongTinHoaDonResponse {
  isError?: boolean;
  message?: string | null;
  data?: HanoiGetThongTinHoaDonData;
  code?: number;
  errors?: unknown;
}
