# MusicLearn

Ứng dụng học nhạc lý tương tác — Vanilla JS Frontend + Node.js Backend.

## Cấu trúc

```
MusicLearn/
├── frontend/          # HTML/CSS/JS thuần, không framework
│   ├── css/           # Design system (variables, reset, layout, components...)
│   ├── js/
│   │   ├── engine/    # Core logic: note-system, staff-mapper, audio-engine, game-state, score-system
│   │   ├── staff/     # Staff renderer + controller + note palette
│   │   ├── app.js     # Bootstrap cho homepage
│   │   ├── page-bootstrap.js  # Bootstrap cho inner pages
│   │   ├── theme.js   # Dark/Light mode
│   │   ├── router.js  # Nav highlight + mobile menu
│   │   └── utils.js   # Shared utilities
│   └── pages/         # quiz, ear-training, melody-builder, achievements, creative
└── backend/           # Node.js + Express + SQLite
    ├── server.js      # Single-file API server
    ├── .env.example   # Template biến môi trường
    └── package.json
```

## Chạy Frontend

```bash
cd frontend/
npx serve .
# Mở http://localhost:3000
```

> Yêu cầu HTTP server vì dùng ES Modules (`type="module"`). Không mở trực tiếp bằng `file://`.

## Chạy Backend

```bash
cd backend/
cp .env.example .env
# Sửa JWT_SECRET trong .env
npm install
npm start
# API chạy tại http://localhost:5000
```

## API Endpoints

| Method | Route | Auth | Mô tả |
|--------|-------|------|-------|
| `GET`  | `/api/health` | — | Health check |
| `POST` | `/api/auth/register` | — | Đăng ký tài khoản |
| `POST` | `/api/auth/login` | — | Đăng nhập |
| `GET`  | `/api/leaderboard?mode=quiz` | — | Bảng xếp hạng Top 20 |
| `POST` | `/api/scores/submit` | JWT | Nộp điểm |
| `GET`  | `/api/scores/me` | JWT | Điểm của tôi |
| `GET`  | `/api/achievements/my-badges` | JWT | Huy hiệu của tôi |
| `GET`  | `/api/badges/all` | — | Tất cả huy hiệu |
| `GET`  | `/api/users/me` | JWT | Profile |

## Keyboard Shortcuts (Quiz)

| Phím | Hành động |
|------|-----------|
| `A / B / C / D` | Chọn đáp án |
| `R` | Nghe lại âm thanh |
| `T` | Chuyển Dark/Light mode |
