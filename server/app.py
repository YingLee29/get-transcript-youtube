#!/usr/bin/env python3
"""
Server AI cục bộ: YouTube URL -> văn bản tiếng Việt.

- Tải audio bằng yt-dlp.
- Nhận dạng giọng nói bằng faster-whisper (chạy trên máy bạn, không gửi dữ liệu đi đâu).

Chạy:
    python app.py                     # http://127.0.0.1:8765
    python app.py --model medium      # đổi model
    python app.py --cookies-from-browser chrome   # video giới hạn tuổi
    python app.py --cli "https://youtu.be/..."    # dùng một lần, in ra terminal

API:
    GET  /health
    POST /transcribe            {"url": "...", "language": "vi", "model": "small"}
    GET  /transcribe/{job_id}
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

APP_VERSION = "1.0.0"
ALLOWED_MODELS = {
    "tiny",
    "tiny.en",
    "base",
    "base.en",
    "small",
    "small.en",
    "medium",
    "medium.en",
    "large-v2",
    "large-v3",
    "distil-large-v3",
}

# Cấu hình toàn cục (được set trong main()).
DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "small")
COOKIES_FILE: Optional[str] = os.environ.get("YTDLP_COOKIES") or None
COOKIES_BROWSER: Optional[str] = os.environ.get("YTDLP_COOKIES_FROM_BROWSER") or None
PLAYER_CLIENT = os.environ.get("YTDLP_PLAYER_CLIENT") or None
DEVICE = "cpu"
COMPUTE_TYPE = "int8"


# ---------------------------------------------------------------------------
# Job & model
# ---------------------------------------------------------------------------


@dataclass
class Job:
    id: str
    url: str
    language: str
    model: str
    status: str = "queued"          # queued | downloading | transcribing | done | error
    progress: float = 0.0
    message: str = "Đang chờ tới lượt…"
    text: str = ""
    srt: str = ""
    title: str = ""
    duration: float = 0.0
    detected_language: str = ""
    error: str = ""
    hint: str = ""
    created: float = field(default_factory=time.time)
    segments: list = field(default_factory=list)


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
MAX_JOBS = int(os.environ.get("MAX_JOBS", "1"))
JOB_SEMAPHORE = threading.Semaphore(MAX_JOBS)

_models: dict[str, object] = {}
_models_lock = threading.Lock()


def _detect_device() -> tuple[str, str]:
    """Trả về (device, compute_type). Dùng GPU nếu có."""
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def get_model(size: str):
    with _models_lock:
        if size not in _models:
            from faster_whisper import WhisperModel

            _models[size] = WhisperModel(size, device=DEVICE, compute_type=COMPUTE_TYPE)
        return _models[size]


def loaded_models() -> list[str]:
    return sorted(_models.keys())


# ---------------------------------------------------------------------------
# Tải audio
# ---------------------------------------------------------------------------


def download_audio(job: Job, workdir: str) -> tuple[str, dict]:
    import yt_dlp

    def hook(d):
        try:
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                got = d.get("downloaded_bytes") or 0
                if total:
                    pct = min(100, got * 100 / total)
                    job.progress = 3 + pct * 0.11
                    job.message = f"Đang tải audio… {int(pct)}%"
            elif d.get("status") == "finished":
                job.progress = 14
                job.message = "Đã tải audio, đang chuẩn bị nhận dạng…"
        except Exception:
            pass

    opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(workdir, "audio.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "restrictfilenames": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "progress_hooks": [hook],
        "nocheckcertificate": True,
    }
    if COOKIES_FILE:
        opts["cookiefile"] = COOKIES_FILE
    if COOKIES_BROWSER:
        opts["cookiesfrombrowser"] = (COOKIES_BROWSER,)
    if PLAYER_CLIENT:
        opts["extractor_args"] = {
            "youtube": {"player_client": [c.strip() for c in PLAYER_CLIENT.split(",") if c.strip()]}
        }

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(job.url, download=True)

    if not info:
        raise RuntimeError("Không lấy được thông tin video.")
    if info.get("_type") == "playlist":
        raise RuntimeError("Link này là playlist. Hãy dùng link của một video cụ thể.")

    files = [
        os.path.join(workdir, f)
        for f in os.listdir(workdir)
        if f.startswith("audio.") and not f.endswith(".part")
    ]
    if not files:
        raise RuntimeError("Không tải được file audio.")
    return files[0], info


# ---------------------------------------------------------------------------
# Xử lý văn bản
# ---------------------------------------------------------------------------


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def build_paragraphs(rows: list[dict], max_chars: int = 620, max_gap: float = 2.5) -> str:
    paras: list[str] = []
    cur: list[str] = []
    cur_len = 0
    prev_end = 0.0

    for row in rows:
        text = row["text"]
        gap = row["start"] - prev_end
        if cur and (gap > max_gap or cur_len + len(text) + 1 > max_chars):
            paras.append(" ".join(cur))
            cur, cur_len = [], 0
        cur.append(text)
        cur_len += len(text) + 1
        prev_end = row["end"]

    if cur:
        paras.append(" ".join(cur))
    return "\n\n".join(paras)


def format_ts(seconds: float) -> str:
    ms_total = int(round(max(0.0, seconds) * 1000))
    hours, ms_total = divmod(ms_total, 3_600_000)
    minutes, ms_total = divmod(ms_total, 60_000)
    secs, ms = divmod(ms_total, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def split_text(text: str, max_chars: int = 90) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    cur = ""
    for word in text.split():
        if cur and len(cur) + 1 + len(word) > max_chars:
            chunks.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
    if cur:
        chunks.append(cur)
    return chunks or [text]


def build_srt(rows: list[dict]) -> str:
    cues: list[tuple[float, float, str]] = []
    for row in rows:
        chunks = split_text(row["text"])
        total = sum(len(c) for c in chunks) or 1
        start = row["start"]
        dur = max(0.5, row["end"] - row["start"])
        for chunk in chunks:
            d = max(0.6, dur * len(chunk) / total)
            cues.append((start, start + d, chunk))
            start += d

    lines = []
    for i, (start, end, text) in enumerate(cues, 1):
        lines.append(f"{i}\n{format_ts(start)} --> {format_ts(end)}\n{text}")
    return "\n\n".join(lines)


# ---------------------------------------------------------------------------
# Chạy job
# ---------------------------------------------------------------------------


def friendly_error(exc: Exception) -> tuple[str, str]:
    msg = str(exc)
    low = msg.lower()

    if "sign in to confirm" in low or "not a bot" in low or "cookies" in low:
        return (
            "YouTube yêu cầu xác nhận không phải robot.",
            "Dừng server rồi chạy lại với:\n"
            "python app.py --cookies-from-browser chrome\n"
            "(đổi chrome thành firefox / edge / brave nếu bạn dùng trình duyệt khác)",
        )
    if "private video" in low:
        return ("Video ở chế độ riêng tư.", "")
    if "members-only" in low or "join this channel" in low:
        return ("Video chỉ dành cho hội viên (members-only).", "")
    if "age" in low and "restrict" in low:
        return (
            "Video bị giới hạn độ tuổi.",
            "Chạy server với --cookies-from-browser chrome để dùng cookie đăng nhập.",
        )
    if "unavailable" in low or "not available" in low:
        return ("Video không khả dụng (đã xoá, chặn khu vực hoặc bị hạn chế).", "")
    if "unsupported url" in low:
        return ("Link không được hỗ trợ. Hãy dùng link video YouTube.", "")
    if "timed out" in low or "timeout" in low:
        return ("Hết thời gian kết nối tới YouTube. Hãy thử lại.", "")
    if "no space" in low or "disk" in low:
        return ("Không đủ dung lượng đĩa để tải audio tạm.", "")

    return (msg or "Lỗi không xác định.", "")


def run_job(job: Job) -> None:
    workdir = tempfile.mkdtemp(prefix="ytts-")
    acquired = False
    try:
        if not JOB_SEMAPHORE.acquire(blocking=False):
            job.message = "Đang chờ job khác xử lý xong…"
            JOB_SEMAPHORE.acquire()
        acquired = True

        job.status = "downloading"
        job.progress = 2
        job.message = "Đang tải audio từ YouTube…"

        audio_path, info = download_audio(job, workdir)
        job.title = info.get("title") or ""
        job.duration = float(info.get("duration") or 0)

        job.status = "transcribing"
        job.progress = 15
        job.message = "AI đang nghe và viết…"

        model = get_model(job.model)
        language = None if job.language in ("", "auto") else job.language

        segments, tinfo = model.transcribe(
            audio_path,
            language=language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,
            temperature=0,
        )

        duration = job.duration or float(getattr(tinfo, "duration", 0) or 0)
        job.detected_language = getattr(tinfo, "language", "") or ""
        job.duration = duration

        rows: list[dict] = []
        for seg in segments:
            text = clean_text(seg.text)
            if text:
                rows.append(
                    {"start": round(float(seg.start), 2), "end": round(float(seg.end), 2), "text": text}
                )
            if duration > 0:
                job.progress = min(99.0, 15 + (float(seg.end) / duration) * 84)
            else:
                job.progress = min(99.0, job.progress + 0.2)
            job.message = f"AI đang nghe và viết… {int(job.progress)}%"

        job.segments = rows
        job.text = build_paragraphs(rows)
        job.srt = build_srt(rows)

        if not job.text:
            job.status = "error"
            job.error = "Không nhận dạng được lời nói trong video (có thể chỉ có nhạc/nền)."
            return

        job.status = "done"
        job.progress = 100
        job.message = "Xong"

    except Exception as exc:  # noqa: BLE001
        job.status = "error"
        job.error, job.hint = friendly_error(exc)
        job.message = "Lỗi"
    finally:
        if acquired:
            JOB_SEMAPHORE.release()
        shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------


class TranscribeIn(BaseModel):
    url: str
    language: str = "vi"
    model: Optional[str] = None


app = FastAPI(title="YouTube → Văn bản (local Whisper)", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

INDEX_HTML = """<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<title>Server AI — YouTube → Văn bản</title>
<style>
 body{{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1b1e24;line-height:1.6}}
 code{{background:#f2f3f6;padding:2px 5px;border-radius:4px}}
 .ok{{color:#12805c;font-weight:600}} .bad{{color:#c02516;font-weight:600}}
 pre{{background:#f7f8fa;border:1px solid #e6e8ec;padding:10px 12px;border-radius:8px;overflow:auto}}
</style></head><body>
<h1>Server AI đang chạy ✓</h1>
<p>Thiết bị: <b>{device}</b> · model mặc định: <b>{model}</b> · đã nạp: {loaded}</p>
<p>Mở extension và bấm <b>AI nghe &amp; viết</b>. Không cần làm gì thêm.</p>
<h3>Thử bằng dòng lệnh</h3>
<pre>curl -X POST http://127.0.0.1:{port}/transcribe \\
  -H "Content-Type: application/json" \\
  -d '{{"url":"https://youtu.be/VIDEO_ID","language":"vi"}}'</pre>
</body></html>"""


@app.get("/", response_class=HTMLResponse)
def index():
    return INDEX_HTML.format(
        device=DEVICE,
        model=DEFAULT_MODEL,
        loaded=", ".join(loaded_models()) or "chưa (sẽ nạp khi dùng)",
        port=os.environ.get("YTT_PORT", "8765"),
    )


@app.get("/health")
def health():
    return {
        "ok": True,
        "version": APP_VERSION,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "model": DEFAULT_MODEL,
        "loaded": bool(loaded_models()),
        "loaded_models": loaded_models(),
    }


@app.post("/transcribe")
def transcribe(body: TranscribeIn):
    url = (body.url or "").strip()
    if not url:
        raise HTTPException(400, "Thiếu link video.")
    if not re.search(r"(youtube\.com|youtu\.be|youtube-nocookie\.com)", url, re.I):
        raise HTTPException(400, "Chỉ hỗ trợ link YouTube.")

    model = (body.model or DEFAULT_MODEL).strip()
    if model not in ALLOWED_MODELS:
        raise HTTPException(400, f"Model không hợp lệ. Chọn một trong: {', '.join(sorted(ALLOWED_MODELS))}")

    language = (body.language or "vi").strip() or "vi"

    job = Job(id=uuid.uuid4().hex[:12], url=url, language=language, model=model)
    with JOBS_LOCK:
        JOBS[job.id] = job

    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return {"job_id": job.id, "status": job.status}


@app.get("/transcribe/{job_id}")
def get_job(job_id: str, segments: bool = False):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Không tìm thấy job (có thể đã hết hạn).")

    data = {
        "job_id": job.id,
        "status": job.status,
        "progress": round(job.progress, 1),
        "message": job.message,
        "text": job.text,
        "srt": job.srt,
        "title": job.title,
        "duration": round(job.duration, 1),
        "detected_language": job.detected_language,
        "model": job.model,
        "error": job.error,
        "hint": job.hint,
    }
    if segments:
        data["segments"] = job.segments
    return data


def _cleanup_loop() -> None:
    while True:
        time.sleep(600)
        cutoff = time.time() - 3 * 3600
        with JOBS_LOCK:
            for jid in [j for j, job in JOBS.items() if job.created < cutoff]:
                JOBS.pop(jid, None)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def run_cli(url: str, language: str, model: str, out_path: Optional[str]) -> int:
    job = Job(id="cli", url=url, language=language, model=model)
    run_job(job)
    if job.status == "error":
        print(f"\n✗ {job.error}")
        if job.hint:
            print(job.hint)
        return 1
    print(f"\n▶ {job.title}  ({job.duration:.0f}s)\n")
    print(job.text)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(job.text + "\n")
        srt_path = os.path.splitext(out_path)[0] + ".srt"
        with open(srt_path, "w", encoding="utf-8") as f:
            f.write(job.srt)
        print(f"\nĐã lưu: {out_path}, {srt_path}")
    return 0


def main() -> None:
    global DEFAULT_MODEL, COOKIES_FILE, COOKIES_BROWSER, PLAYER_CLIENT, DEVICE, COMPUTE_TYPE

    parser = argparse.ArgumentParser(
        description="Server AI chuyển video YouTube thành văn bản (faster-whisper)."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default=DEFAULT_MODEL, choices=sorted(ALLOWED_MODELS))
    parser.add_argument("--language", default="vi", help="vi, en, auto, ...")
    parser.add_argument("--cookies", help="File cookies.txt (định dạng Netscape)")
    parser.add_argument(
        "--cookies-from-browser",
        help="Lấy cookie từ trình duyệt: chrome, firefox, edge, brave, chromium",
    )
    parser.add_argument("--player-client", help="Ép yt-dlp dùng client, ví dụ: web,android,ios")
    parser.add_argument("--preload", action="store_true", help="Nạp model ngay khi khởi động")
    parser.add_argument("--cli", metavar="URL", help="Chạy một lần rồi thoát")
    parser.add_argument("-o", "--out", help="File .txt đầu ra khi dùng --cli")
    args = parser.parse_args()

    DEFAULT_MODEL = args.model
    COOKIES_FILE = args.cookies or COOKIES_FILE
    COOKIES_BROWSER = args.cookies_from_browser or COOKIES_BROWSER
    PLAYER_CLIENT = args.player_client or PLAYER_CLIENT
    DEVICE, COMPUTE_TYPE = _detect_device()

    if args.cli:
        raise SystemExit(run_cli(args.cli, args.language, args.model, args.out))

    os.environ["YTT_PORT"] = str(args.port)

    print("=" * 62)
    print("  YouTube → Văn bản · server AI cục bộ")
    print("=" * 62)
    print(f"  Thiết bị : {DEVICE} ({COMPUTE_TYPE})")
    print(f"  Model    : {args.model}")
    print(f"  Địa chỉ  : http://{args.host}:{args.port}")
    print("  Lần đầu chạy, model sẽ được tải về (có thể mất vài phút).")
    print("=" * 62)

    threading.Thread(target=_cleanup_loop, daemon=True).start()

    if args.preload:
        def _preload():
            try:
                print(f"→ Đang nạp model {args.model}…")
                get_model(args.model)
                print("→ Nạp model xong.")
            except Exception as exc:  # noqa: BLE001
                print(f"! Không nạp được model: {exc}")

        threading.Thread(target=_preload, daemon=True).start()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
