/**
 * Browser-like HTTP headers cho các API call EVN Hà Nội (không qua Playwright).
 *
 * EVN Hà Nội (apicskh.evnhanoi.vn + evnhanoi.vn) kiểm tra các sec-ch-ua headers —
 * thiếu có thể bị từ chối hoặc trả lỗi. Giá trị lấy từ Chromium 146 thực tế.
 */

export const HANOI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/** Headers chung — không kèm Authorization, Content-Type, Accept (caller tự thêm). */
export const HANOI_BASE_HEADERS: Record<string, string> = {
  "User-Agent": HANOI_UA,
  "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
};

/**
 * Headers cho POST `connect/token` (OAuth2 password grant).
 * Referer = trang chủ EVN Hà Nội (origin nơi form đăng nhập gọi đến STS).
 */
export function buildHanoiStsTokenHeaders(siteOrigin: string): Record<string, string> {
  return {
    ...HANOI_BASE_HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json, text/plain, */*",
    Referer: siteOrigin.replace(/\/$/, "") + "/",
    Origin: siteOrigin.replace(/\/$/, ""),
  };
}

/**
 * Headers cho các GET/POST API EVN Hà Nội sau đăng nhập (Bearer token).
 * @param accessToken  Bearer access_token từ connect/token.
 * @param referer      URL trang web đang "mở" (giả lập browser context).
 */
export function buildHanoiApiAuthHeaders(
  accessToken: string,
  referer: string,
): Record<string, string> {
  return {
    ...HANOI_BASE_HEADERS,
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    Referer: referer,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}
