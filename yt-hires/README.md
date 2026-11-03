# YT Hi-Res

Chrome extension Manifest V3 nhỏ gọn, luôn ép trình phát YouTube chạy ở **độ
phân giải cao nhất mà video có**, trong giới hạn "mức trần" do bạn chọn. Không
dùng thư viện ngoài, không cần bước build — chỉ cần **Load unpacked**.

## Tính năng

- Tự áp dụng trên `https://www.youtube.com/*`, kể cả khi bạn chuyển video mà
  không tải lại trang.
- Luôn chọn mức cao nhất mà video cung cấp, không để YouTube rơi về `Auto` khi
  đổi video, đổi tab hoặc sau quảng cáo.
- Popup bật/tắt extension và chọn mức trần: **1080p / 1440p / 2160p / 4320p**.
- Cài đặt được lưu bằng `chrome.storage.sync`, đổi là áp dụng ngay cho tab
  YouTube đang mở, không cần tải lại.
- Không quảng cáo, không thu thập dữ liệu, không gọi dịch vụ bên ngoài.

## Cài đặt

1. Tải repo này về máy (hoặc `git clone`).
2. Mở Chrome và truy cập `chrome://extensions`.
3. Bật **Developer mode** ở góc phải trên.
4. Bấm **Load unpacked** và chọn thư mục `yt-hires/` (thư mục chứa
   `manifest.json`).
5. Mở (hoặc tải lại) một tab YouTube, vào một video bất kỳ. Extension sẽ tự
   chọn chất lượng cao nhất trong mức trần.

> Sau khi cài, cập nhật hoặc tải lại extension, hãy tải lại tab YouTube đang mở
> để content script được nạp lại.

Extension cần Chrome **111 trở lên** (Manifest V3 với content script chạy trong
`MAIN` world).

## Sử dụng

Bấm biểu tượng **YT Hi-Res** trên thanh công cụ để mở popup:

- **Công tắc**: bật/tắt extension. Khi tắt, extension ngừng ép chất lượng và trả
  quyền chọn về `Auto` cho YouTube.
- **Mức trần**: giới hạn độ phân giải tối đa được phép dùng.
  - Mặc định là **2160p (4K)**, tương ứng thứ tự ưu tiên 2160p → 4320p: video
    4K/8K sẽ chạy 2160p cho đến khi bạn nâng mức trần lên 4320p.
  - Video 1080p vẫn chạy 1080p dù mức trần là 2160p — không thể vượt quá chất
    lượng gốc.
- Khi extension đang bật, nó sẽ áp lại mức đã chọn ngay cả khi bạn chọn chất
  lượng khác bằng tay trong menu YouTube. Muốn tự chọn chất lượng, hãy tắt công
  tắc trước.
- **Thẻ trạng thái** cho biết hiện tại trình phát đang ở chất lượng nào, video hỗ
  trợ tới đâu và extension đang ở trạng thái gì.

Cài đặt được lưu lại giữa các lần mở trình duyệt và đồng bộ qua tài khoản Chrome
nếu bạn bật đồng bộ.

## Cách hoạt động

- `page.js` chạy trong **MAIN world** của YouTube để gọi được API nội bộ của
  trình phát (`#movie_player`): `getAvailableQualityLevels()`,
  `setPlaybackQualityRange()`, `setPlaybackQuality()`.
- `content.js` chạy trong **isolated world**, đọc `chrome.storage`, chuyển cài
  đặt sang `page.js` và trả trạng thái cho popup.
- `page.js` kiểm tra định kỳ (khoảng 0,8 giây), phát hiện video mới qua
  `getVideoData().video_id`, lắng nghe `yt-navigate-finish`,
  `yt-page-data-updated` và `loadedmetadata`; nếu chất lượng bị lệch khỏi mức
  đích, nó đặt lại ngay.
- Popup lưu thay đổi vào `chrome.storage.sync`; `content.js` nghe
  `storage.onChanged` và áp dụng tức thì, không cần tải lại tab.

### Cách chọn "mức cao nhất"

1. Lấy danh sách chất lượng video thực sự cung cấp (bỏ `Auto`).
2. Chọn chất lượng **cao nhất mà không vượt quá mức trần**.
3. Nếu video không có mức nào ở hoặc dưới mức trần (hiếm), dùng mức thấp nhất
   trên mức trần để video vẫn phát được.
4. Ép cả `setPlaybackQualityRange` lẫn `setPlaybackQuality`, và nhắc lại khi
   YouTube cố đổi về `Auto`.

## Giới hạn

- **Không thể vượt quá độ phân giải gốc.** Extension chỉ chọn trong các mức mà
  YouTube đang cung cấp cho video đó. Video 1080p không thể thành 4K, và việc
  chọn mức trần 4320p không tạo ra bản 8K nếu nguồn không có.
- Chất lượng còn phụ thuộc thiết bị, băng thông, gói YouTube (một số mức HDR /
  chất lượng cao yêu cầu Premium), chế độ DRM và tình trạng máy chủ.
- Trong lúc phát **quảng cáo**, extension tạm nhường quyền cho trình phát và ép
  lại ngay sau khi quảng cáo kết thúc.
- Chỉ áp dụng cho `www.youtube.com`. Trang **Shorts** dùng trình phát khác nên
  có thể không được áp dụng; trang nhúng (`/embed/`) và YouTube Music chưa được
  kiểm thử.
- YouTube có thể thay đổi API nội bộ bất kỳ lúc nào. Nếu popup báo "Không tìm
  thấy trình phát", hãy tải lại trang; nếu vẫn lỗi, extension cần được cập nhật.
- Ép quá cao so với đường truyền có thể gây dừng để tải (buffering). Hãy hạ mức
  trần nếu mạng không theo kịp.

## Cấu trúc

```
yt-hires/
├── manifest.json     # Manifest V3, quyền storage + host YouTube
├── background.js     # Service worker: khởi tạo cài đặt mặc định
├── content.js        # Isolated world: cầu nối chrome.storage ↔ page.js
├── page.js           # MAIN world: điều khiển chất lượng trình phát
├── popup.html        # Giao diện popup
├── popup.css
├── popup.js          # Lưu/đọc chrome.storage, hiển thị trạng thái
├── icons/            # Icon 16/32/48/128 px
└── README.md
```

## Gỡ cài đặt

Mở `chrome://extensions`, tìm **YT Hi-Res** và bấm **Remove**. Cài đặt trong
`chrome.storage.sync` sẽ bị xoá cùng extension.
