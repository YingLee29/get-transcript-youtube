#!/usr/bin/env bash
# Chạy server AI. Tự lo phần cài đặt, kể cả máy Debian/Ubuntu bị khoá pip (PEP 668).
set -uo pipefail

cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "✗ Không tìm thấy python3. Hãy cài Python 3.10 – 3.12."
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "! Chưa có ffmpeg — thường vẫn chạy được, nhưng nên cài để an toàn:"
  echo "    sudo apt install ffmpeg      # Debian / Ubuntu"
  echo "    brew install ffmpeg          # macOS"
  echo
fi

have_deps() {
  "$1" -c "import fastapi, uvicorn, yt_dlp, faster_whisper, av" >/dev/null 2>&1
}

install_requirements() {
  local py="$1"
  local errfile
  errfile="$(mktemp)"
  local flags=(-q -r requirements.txt --upgrade)

  if "$py" -m pip install --user "${flags[@]}" 2>"$errfile"; then
    rm -f "$errfile"
    return 0
  fi

  if grep -q "externally-managed-environment" "$errfile" 2>/dev/null; then
    echo "! Python của hệ thống bị khoá cài đặt (PEP 668)."
    echo "  Thử lại với --break-system-packages (chỉ cài cho user hiện tại)..."
    if "$py" -m pip install --user --break-system-packages "${flags[@]}"; then
      rm -f "$errfile"
      return 0
    fi
  fi

  echo "✗ Không cài được thư viện. Chi tiết:"
  sed 's/^/    /' "$errfile" | tail -20
  rm -f "$errfile"
  return 1
}

# 1) Đã có đủ thư viện trong python hiện tại -> chạy luôn, không cài gì.
if have_deps "$PY"; then
  exec "$PY" app.py "$@"
fi

# 2) Thử tạo virtualenv (cách sạch nhất).
CREATE_ERR="$(mktemp)"
if "$PY" -m venv .venv 2>"$CREATE_ERR"; then
  rm -f "$CREATE_ERR"
  # shellcheck disable=SC1091
  source .venv/bin/activate
  echo "→ Đang cài thư viện vào .venv (lần đầu có thể mất vài phút)…"
  python -m pip install -q --upgrade pip
  if install_requirements python; then
    exec python app.py "$@"
  fi
  exit 1
fi

echo "! Không tạo được virtualenv."
if grep -qi "ensurepip\|venv" "$CREATE_ERR" 2>/dev/null; then
  echo "  Ubuntu/Debian thiếu gói python3-venv. Cài bằng:"
  echo "      sudo apt install python3-venv"
  echo "  (không bắt buộc — sẽ thử cài trực tiếp vào môi trường người dùng)"
fi
rm -f "$CREATE_ERR"
echo

# 3) Dự phòng: cài vào môi trường người dùng.
echo "→ Đang cài thư viện vào môi trường người dùng…"
if install_requirements "$PY"; then
  exec "$PY" app.py "$@"
fi

echo
echo "Gợi ý: cài python3-venv rồi chạy lại sẽ sạch hơn:"
echo "    sudo apt install python3-venv"
exit 1
