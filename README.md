# YouTube → Văn bản (Tiếng Việt)

Extension Chrome/Edge/Cốc Cốc giúp **dán link YouTube (kể cả Shorts) và nhận lại văn bản** của lời nói trong video.

Có 2 chế độ, dùng độc lập hoặc kết hợp:

| | **Lấy phụ đề** | **AI nghe & viết** |
|---|---|---|
| Cần cài đặt | Không | Có (Python + server local) |
| Tốc độ | 2–5 giây | ~1–3 phút cho video 10 phút |
| Nguồn văn bản | Phụ đề có sẵn / phụ đề tự động của YouTube | Whisper nhận dạng trực tiếp từ âm thanh |
| Video **không có phụ đề** | ✗ | ✓ |
| Độ chính xác tiếng Việt | Tuỳ phụ đề (ASR có thể sai) | Cao, nhất là model `small` trở lên |
| Chi phí | Miễn phí | Miễn phí (chạy trên máy bạn) |

---

## 1. Cài extension

1. Mở Chrome (hoặc Edge / Cốc Cốc / Brave / Opera) và vào:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Cốc Cốc: `coccoc://extensions`
2. Bật **Chế độ dành cho nhà phát triển** (*Developer mode*) — góc trên bên phải.
3. Bấm **Tải tiện ích đã giải nén** (*Load unpacked*).
4. Chọn thư mục **`extension`** trong thư mục dự án này.
5. Ghim extension lên thanh công cụ (biểu tượng mảnh ghép → ghim).

> Extension không có trên Chrome Web Store nên bạn tự tải — đây là cách bình thường để cài extension chưa phát hành.

---

## 2. Dùng ngay (không cần cài gì thêm)

1. Mở một video YouTube hoặc Shorts.
2. Bấm icon extension → link được điền sẵn.
3. Bấm **Lấy phụ đề**.

Kết quả có 2 tab:

- **Văn bản** — đã ghép thành đoạn văn, sửa được trực tiếp.
- **SRT** — phụ đề kèm mốc thời gian, tải về dùng cho video editor.

Nút **Sao chép**, **Tải .txt**, **Tải .srt** ở cuối.

Bạn cũng có thể dán link của video khác (không cần mở tab đó).

> Nếu video chỉ có phụ đề tiếng Anh, extension sẽ thử dịch tự động sang tiếng Việt; nếu YouTube chặn, nó tự quay về phụ đề gốc.

---

## 3. Bật AI Whisper (cho video không có phụ đề)

### Yêu cầu

- **Python 3.10 – 3.12** ([python.org](https://www.python.org/downloads/))
- **ffmpeg** (khuyến nghị):
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg`
- ~1 GB dung lượng trống (model + thư viện). RAM: 4 GB trở lên.

### Cài và chạy

**Linux / macOS**

```bash
cd server
./run.sh
```

**Windows**: nhấp đúp `server\run.bat`

Hoặc thủ công (nên dùng virtualenv):

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

> Ubuntu/Debian báo thiếu `venv`: chạy `sudo apt install python3-venv` trước.

Lần chạy đầu tiên, model sẽ được tải về (model `small` ≈ 480 MB). Khi thấy dòng:

```
Uvicorn running on http://127.0.0.1:8765
```

→ quay lại extension, bấm **AI nghe & viết**.

Server chỉ lắng nghe trên `127.0.0.1` — **không mở ra Internet**.

### Chọn model

Đổi trong **Cài đặt** của extension (hoặc `python app.py --model medium`):

| Model | Kích thước | Tốc độ (CPU) | Ghi chú |
|---|---|---|---|
| `tiny` | ~75 MB | rất nhanh | thử nghiệm |
| `base` | ~145 MB | nhanh | |
| `small` | ~480 MB | trung bình | **khuyến nghị** |
| `medium` | ~1.5 GB | chậm | chính xác hơn |
| `large-v3` | ~3 GB | rất chậm trên CPU | cần GPU để dùng thực tế |

Có GPU NVIDIA (CUDA) thì server tự dùng GPU và nhanh hơn nhiều lần.

### Video giới hạn tuổi / cần đăng nhập

```bash
python app.py --cookies-from-browser chrome
```

(đổi `chrome` thành `firefox`, `edge`, `brave`… tuỳ trình duyệt bạn dùng)

Hoặc xuất file cookies bằng extension "Get cookies.txt" rồi:

```bash
python app.py --cookies /duong/dan/cookies.txt
```

### Dùng không cần extension

```bash
cd server
python app.py --cli "https://youtu.be/VIDEO_ID" -o transcript.txt
```

---

## Cách hoạt động

```
┌──────────────────────────┐
│  Extension (popup)       │
│  dán link → videoId      │
└───────────┬──────────────┘
            │
   ┌────────┴─────────┐
   ▼                  ▼
Lấy phụ đề        AI Whisper
   │                  │
   │ 1. đọc player     │ POST /transcribe
   │    response trong │        │
   │    tab đang mở    │        ▼
   │ 2. InnerTube      │  yt-dlp tải audio
   │    ANDROID_VR     │        │
   │ 3. HTML watch     │        ▼
   │    page           │  faster-whisper
   ▼                  ▼  (chạy local)
parse json3 / srv3 → văn bản + SRT
```

- Phụ đề lấy qua API công khai của YouTube, có gửi cookie trình duyệt của bạn (nhờ vậy ít bị chặn hơn).
- Audio của chế độ AI được tải vào thư mục tạm và **xoá ngay sau khi nhận dạng xong**.

---

## Cấu trúc thư mục

```
yt-voice-to-text/
├── extension/            # Tiện ích (nạp thư mục này vào Chrome)
│   ├── manifest.json
│   ├── popup.html / popup.css / popup.js
│   ├── youtube.js        # Logic lấy phụ đề, parse json3/srv3, tạo SRT
│   └── icons/
├── server/
│   ├── app.py            # FastAPI + faster-whisper
│   ├── requirements.txt
│   ├── run.sh            # Chạy trên Linux/macOS
│   └── run.bat           # Chạy trên Windows
└── tests/
    └── test_youtube.js   # Test logic parse (node tests/test_youtube.js)
```

---

## Xử lý lỗi

| Hiện tượng | Cách xử lý |
|---|---|
| “Video này không có phụ đề sẵn” | Bật server AI rồi bấm **AI nghe & viết**. |
| “Nội dung trả về rỗng (YouTube đang chặn)” | Chờ 1–2 phút rồi thử lại; hoặc dùng AI. |
| “Không truy cập được video” | Video riêng tư / giới hạn tuổi / chặn vùng. Dùng `--cookies-from-browser`. |
| “Chưa kết nối được server AI” | Server chưa chạy, hoặc sai địa chỉ trong Cài đặt. Kiểm tra bằng nút **Kiểm tra kết nối**. |
| AI chạy rất chậm | Giảm model xuống `small`/`base`, hoặc bật GPU. |
| Lỗi `No module named ...` | Chạy `pip install -r requirements.txt` đúng thư mục `server/`. |
| Lỗi `error: externally-managed-environment` (PEP 668) | Chạy `./run.sh` — script đã tự xử lý. Hoặc cài `sudo apt install python3-venv` rồi chạy lại. |
| Windows báo `python` không tồn tại | Cài Python và nhớ tick “Add python.exe to PATH”. |

---

## API server (cho ai muốn tích hợp)

```bash
# Gửi job
curl -X POST http://127.0.0.1:8765/transcribe \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/VIDEO_ID","language":"vi","model":"small"}'
# -> {"job_id":"a1b2c3d4e5f6","status":"queued"}

# Xem tiến độ / kết quả
curl http://127.0.0.1:8765/transcribe/a1b2c3d4e5f6
```

`GET /health` trả về thiết bị, model và trạng thái. Mở `http://127.0.0.1:8765` bằng trình duyệt để xem trang trạng thái.

---

## Quyền riêng tư & lưu ý

- Không có máy chủ nào của tác giả. Extension chỉ nói chuyện với **youtube.com** và **server AI trên máy bạn**.
- Audio tạm bị xoá sau khi xử lý; văn bản chỉ nằm trong popup cho tới khi bạn tải về.
- Phụ đề tự động (ASR) của YouTube thường sai chính tả tiếng Việt — dùng AI Whisper khi cần độ chính xác.
- Chỉ sử dụng với nội dung bạn có quyền truy cập/sử dụng, và tuân thủ Điều khoản dịch vụ của YouTube.

---

## Phát triển

```bash
node tests/test_youtube.js   # test logic parse phụ đề
python -m py_compile server/app.py
```

Muốn đổi giao diện: sửa `extension/popup.css`. Muốn thêm ngôn ngữ: thêm `option` trong `popup.html`, Whisper hỗ trợ gần 100 ngôn ngữ.
# get-transcript-youtube
# get-transcript-youtube
