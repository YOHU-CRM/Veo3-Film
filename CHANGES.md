# Bản cập nhật + nạp ảnh → video (chữ giữ nguyên)

Nền là bản "yohu-dung-video-tu-dong-cap-nhat" (máy dựng FFmpeg + lớp engine). Mọi logic cũ được GIỮ NGUYÊN;
chỉ BỔ SUNG phần cảnh ảnh. Những dòng cũ duy nhất bị đụng chạm là các dòng phải đưa vào nhánh "nếu là video"
(nội dung xử lý video y hệt).

## Tính năng mới
- Ô "+ Thêm Ảnh / Slide" trong mục Dựng video tự động (kéo thả nhiều ảnh, xếp theo số trong tên file).
- Mỗi cảnh ảnh chọn 1 trong 4 kiểu: 
  * Tự động (hiệu ứng đầy đủ, giống video mẫu): chữ lớn quét hiện, thẻ trượt hai bên, vòng tròn bật lên, lóe sáng lướt qua chữ, viền sáng quanh thẻ/ô.
  * An toàn chữ tuyệt đối: chỉ trượt / hiện dần / quét hiện / viền sáng NGOÀI khối. Không phóng to-thu nhỏ, không đổi màu chữ.
  * Zoom nhẹ (ảnh chụp)   * Đứng yên
- Số giây mỗi ảnh (có voice thì theo voice), nút "Áp dụng cho mọi ảnh", hiển thị số khối nhận diện được.
- Chạy ở CẢ HAI đường dựng bằng cùng một mã (shared/imageMotion): máy dựng FFmpeg và trình duyệt.
- Ảnh trộn được với video clip, voice, phụ đề, nhạc nền trong cùng phim.
- Slide (chữ/thẻ/hình) tự nhận diện; ảnh chụp thường tự chuyển sang zoom nhẹ.

## Thay đổi theo file (chép đè, giữ nguyên thư mục)
- shared/imageMotion/*              MỚI: phân tích ảnh, kế hoạch chuyển động, vẽ khung (chạy được ở trình duyệt và Node)
- shared/render/plan.ts, types.ts   thêm cảnh ảnh vào kế hoạch thời gian dùng chung
- src/engine/*                      nhánh cảnh ảnh trong browserEngine / remoteEngine; imageCache.ts mới
- src/components/video/AutoVideoCreator.tsx   giao diện nạp ảnh
- render-server/src/{imageScene,render,index}.ts, package.json (+@napi-rs/canvas), README.md, test/*

## Chạy
Trong thư mục render-server: `npm install` (có thêm thư viện vẽ ảnh) rồi chạy máy dựng như cũ.
Thiếu thư viện đó thì chỉ cảnh ảnh bị bỏ qua (kèm cảnh báo) và giao diện tự dùng bộ dựng trình duyệt cho cảnh ảnh.

## Đã kiểm tra
- `npm test` trong render-server: 17/17 (6 bài gốc + 4 bài dựng phim ảnh bằng FFmpeg thật + 7 bài bộ chuyển động ảnh).
- Kế hoạch dùng chung (shared/render/plan.test.ts): 10/10. tsc strict render-server + shared: 0 lỗi.
- Dự án đầy đủ: 0 lỗi kiểu ở file mới/sửa; vite build đạt.
- 7 thẻ mẫu T1–T7: không còn nội dung sót ở nền (0 điểm ảnh); khung cuối = ảnh gốc từng điểm ảnh.
- Chế độ an toàn: lõi mọi khối trùng ảnh gốc từng điểm ảnh ngay cả khi đang sáng viền (có bài test).
- Tốc độ máy thử (1 nhân CPU): 49 giây video (7 ảnh) dựng trong 83 giây. Máy nhiều nhân nhanh hơn (chưa đo).
## Chưa kiểm tra
- Trình duyệt thật (ghi hình, âm thanh), giao diện chưa được mở bằng trình duyệt thật, Safari, máy dựng trên Windows/macOS.
