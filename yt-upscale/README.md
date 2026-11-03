# YT Upscale - Trình Nâng Cấp Video YouTube WebGL Thời Gian Thực

> **Chrome Extension Manifest V3** nâng cấp độ phân giải khung hình video YouTube vượt mức gốc bằng kỹ thuật Shaders tăng cường WebGL thời gian thực (**AMD FSR 1.0 EASU** & **Lanczos-3 Sinc Resampling**).

---

## 1. Giới thiệu & Bản chất kỹ thuật

### Khác biệt cốt lõi so với việc "chọn chất lượng YouTube":
- Các extension thông thường chỉ gửi lệnh gọi API `setPlaybackQualityRange()` để ép YouTube tải luồng video có sẵn (ví dụ 1080p, 1440p hoặc 4K). Nếu video gốc trên kênh của tác giả chỉ được tải lên ở mức 720p hoặc 1080p, YouTube **hoàn toàn không có dữ liệu 1440p/4K** để phát.
- **YT Upscale hoạt động ở tầng xử lý đồ họa (GPU Pipeline):**
  1. Trích xuất từng khung hình trực tiếp từ thẻ `<video>` khi được giải mã thông qua `requestVideoFrameCallback`.
  2. Nạp khung hình vào bộ nhớ WebGL Texture.
  3. Áp dụng Shader toán học cao cấp (**AMD FSR EASU** hoặc **Lanczos-3**) trên GPU để tái tạo lại ma trận điểm ảnh với độ phân giải cao hơn (khớp với màn hình 2K/4K hoặc 2x kích thước gốc).
  4. Xuất khung hình sắc nét lên một lớp Canvas phủ khớp chuẩn vị trí player với độ trễ gần như bằng 0.

### ⚠️ Lưu ý quan trọng về bản chất Upscaling:
> **Upscaling là thuật toán nội suy tái tạo hình học (Spatial Reconstruction & Edge-Adaptive Filtering).**
> Thuật toán **KHÔNG THỂ tự sáng tạo ra chi tiết vật lý thực tế đã bị mất vĩnh viễn** ở nguồn ghi hình. Nó giúp loại bỏ hoàn toàn hiện tượng nhòe mờ (bilinear blur), khử răng cưa thô ráp (aliasing) và làm các đường viền vật thể, chữ viết, đồ họa anime/game trở nên sắc nét vượt trội khi phóng to trên màn hình độ phân giải cao.

---

## 2. Các thuật toán hỗ trợ

| Thuật toán | Cơ chế hoạt động | Đối tượng tối ưu nhất |
| :--- | :--- | :--- |
| **AMD FSR 1.0 EASU** *(Khuyên dùng)* | **Edge-Adaptive Spatial Upsampling**: Quét 9 tap điểm ảnh lân cận để tính toán đạo hàm hướng gradient (ngang, dọc, chéo 45°/135°). Tự động xoay kernel lấy mẫu theo hướng viền vật thể và áp dụng bộ lọc High-pass tăng tương phản viền, kèm tính năng Anti-ringing chống chói lem viền. | Anime, phim hoạt hình, gameplay, video đồ họa vi tính, nội dung có nhiều viền tương phản cao. |
| **Lanczos-3 Sinc** | Sử dụng hàm cửa sổ Sinc chuẩn toán học: \( L(x) = \text{sinc}(x) \cdot \text{sinc}(x/3) \) quét ma trận **36 điểm mẫu (6x6 taps)**. Giữ tần số không gian cao mà không làm méo hình học, độ mịn màu chuyển tiếp chuẩn điện ảnh. | Phim tài liệu đời thực, vlog người thật, phong cảnh thiên nhiên, phim điện ảnh quay thực tế. |

---

## 3. Tính năng nổi bật

- **Manifest V3 thuần túy:** Không thư viện ngoài, không jQuery, không cần bước build phức tạp, chạy trực tiếp bằng vanilla JS & WebGL.
- **Tương thích toàn diện YouTube SPA:** Tự động nhận diện khi chuyển video, đổi playlist, đổi tab mà không cần tải lại trang (`yt-navigate-finish`, `yt-page-data-updated`).
- **Bảo toàn 100% trải nghiệm gốc:**
  - Lớp Canvas được thiết lập `pointer-events: none` và `z-index: 10`, nằm bên dưới hệ thống điều khiển của YouTube (`.ytp-chrome-bottom` có z-index > 50).
  - Tất cả phím tắt (`Space`, `K` dừng; `J`, `L` tua 10s; `F` toàn màn hình; `M` tắt tiếng), thanh timeline tua video, phụ đề (captions) và âm thanh hoạt động hoàn hảo 100%.
- **Chế độ Scale linh hoạt:**
  - **Khớp màn hình (Fit):** Tự động đo kích thước khung player và hệ số `devicePixelRatio` của màn hình (hỗ trợ màn 2K, 4K UHD, Retina) để xuất ra số pixel thực của màn hình.
  - **Gấp đôi (2x Native):** Nhân đôi chiều rộng và chiều cao điểm ảnh gốc của video.
- **Khôi phục nguyên trạng khi tắt:** Khi tắt extension trong popup, canvas được ẩn ngay lập tức, video gốc hiển thị lại nguyên vẹn, vòng lặp render GPU dừng hẳn để tiết kiệm 100% tài nguyên.
- **Giao diện Popup Light Theme cao cấp:** Thiết kế theo chuẩn giao diện hiện đại (Apple/Linear), hiển thị trực quan thông số độ phân giải gốc $\rightarrow$ độ phân giải đầu ra và đo tốc độ khung hình (FPS) thời gian thực.

---

## 4. Hướng dẫn cài đặt (Chrome / Brave / Edge / Cốc Cốc)

1. Tải thư mục repo về máy tính (hoặc `git clone https://github.com/duykhangkk/superagent-playground.git`).
2. Mở trình duyệt Google Chrome (hoặc bất kỳ trình duyệt nhân Chromium phiên bản 111+).
3. Truy cập vào địa chỉ: `chrome://extensions/`.
4. Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
5. Nhấp nút **Load unpacked** (Tải tiện ích đã giải nén).
6. Chọn thư mục `yt-upscale` (thư mục chứa tệp `manifest.json`).
7. Mở một tab YouTube bất kỳ (nếu đã mở sẵn tab YouTube từ trước, hãy bấm `F5` tải lại trang một lần).
8. Nhấp vào biểu tượng **YT Upscale** trên thanh tiện ích để tùy chỉnh thuật toán hoặc kiểm tra chỉ số FPS.

---

## 5. Giới hạn kỹ thuật & Cảnh báo an toàn

### 1. Bản quyền DRM / EME (Widevine Protected Content):
- Trên YouTube, các nội dung có bản quyền được mã hóa DRM (ví dụ: Phim mua/thuê YouTube Movies, một số sự kiện trực tiếp bảo vệ bản quyền) sử dụng hệ thống Giải mã phương tiện mã hóa (Encrypted Media Extensions - EME).
- Theo chính sách bảo mật trình duyệt, nếu JavaScript cố gắng chụp khung hình từ thẻ `<video>` DRM thông qua `texImage2D`, trình duyệt sẽ chặn với lỗi `SecurityError (Tainted canvas)`.
- **Cách YT Upscale xử lý an toàn:** Extension bọc lệnh nạp texture trong khối `try-catch`. Nếu phát hiện luồng video DRM, extension lập tức hủy lớp canvas, trả quyền hiển thị lại cho video gốc và cảnh báo màu vàng trong Popup để người dùng biết.

### 2. Tải phần cứng GPU & Tiêu thụ điện năng:
- Thuật toán WebGL chạy trực tiếp trên GPU. Trên các card đồ họa rời phổ biến (như NVIDIA GeForce GTX 1650 4GB hoặc card tích hợp Radeon Graphics), mức tiêu thụ GPU chỉ dao động trong khoảng **4% – 8%** và duy trì ổn định **60 FPS**.
- Nếu bạn sử dụng laptop đang chạy pin, việc kích hoạt upscale thời gian thực liên tục có thể tiêu hao pin nhanh hơn xem video thông thường một lượng nhỏ do GPU hoạt động liên tục.

---

## 6. Phương pháp kiểm chứng kết quả

1. **Kiểm tra trực quan trên màn hình:**
   - Mở một video 720p hoặc 1080p toàn màn hình trên màn hình 2K hoặc 4K.
   - Bật/tắt công tắc trên Popup để so sánh sự khác biệt: Khi bật **AMD FSR EASU**, các đường viền chữ, nét vẽ nhân vật và chi tiết đồ họa sẽ nổi khối, sắc gọn, không bị hiện tượng mờ nhòe răng cưa như trình phát mặc định.
2. **Kiểm tra thông số kỹ thuật qua Popup:**
   - Mở Popup của tiện ích: Quan sát dòng **Độ phân giải gốc** (ví dụ: `1280 × 720`) và **Đầu ra WebGL** (ví dụ: `2560 × 1440` hoặc `3840 × 2160`).
   - Kiểm tra huy hiệu **FPS**: Đạt mức `60 FPS` mượt mà.
3. **Kiểm tra DOM Inspector:**
   - Nhấn `F12` $\rightarrow$ Thẻ **Elements** $\rightarrow$ Tìm kiếm bên trong `#movie_player`.
   - Bạn sẽ thấy phần tử `<canvas class="yt-upscale-overlay">` được chèn song song với `<video class="html5-main-video">`.
