# Bản V3 – Bước 1 (nhạc nền + thời lượng)

## Đã làm
- Thứ tự ưu tiên thời lượng mỗi cảnh: (1) bạn tự đặt > (2) thời lượng giọng đọc > (3) mặc định ảnh / độ dài clip.
  Ô "Thời lượng cảnh" có ở MỌI cảnh (ảnh và video); bỏ trống = tự động. Có cảnh báo khi giọng đọc bị cắt, khi clip sẽ lặp.
- Nhạc nền: ô kéo thả không đoán nữa. File âm thanh chưa rõ là giọng đọc hay nhạc nền -> hiện khung hỏi.
  Nhạc luôn chạy SUỐT phim dưới giọng đọc; trình duyệt cũng mờ dần vào (1s) và ra (cuối phim) như máy dựng FFmpeg.
- Chia 1 file ghi âm: thêm chế độ "đúng số cảnh, theo tỉ lệ chữ/thời lượng từng cảnh" (dùng HẾT giọng đọc), bên cạnh chế độ "mỗi đoạn N giây".
- Giữ PowerPoint/Word/Excel (đọc chữ làm kịch bản/phụ đề).

## Kiểm thử
34 bài kiểm thử tự động đều qua; vite build qua.

## Các bước tiếp theo (đã thống nhất)
2) Dựng từng khung hình để hết giật. 3) Chữ chạy theo cấp bậc. 4) PDF đọc trực tiếp lớp chữ. 5) AI nhìn trang (Gemini) và các mục bổ sung.
