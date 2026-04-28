# BatchDL — Smart Batch Media Downloader

A high-performance, lightweight batch media downloader with real-time progress tracking, smart deduplication, and zero long-term storage.

---

## 📁 Project Structure

```
smart-batch-downloader/
├── backend/
│   ├── src/
│   │   ├── config/index.js        — Environment config
│   │   ├── middleware/
│   │   │   └── rateLimiter.js     — Rate limiting
│   │   ├── routes/
│   │   │   └── downloads.js       — All API routes
│   │   ├── services/
│   │   │   ├── queue.js           — In-memory concurrency queue
│   │   │   ├── downloader.js      — yt-dlp wrapper + streaming
│   │   │   └── websocket.js       — Real-time WS updates
│   │   ├── utils/
│   │   │   └── validate.js        — URL validation
│   │   └── index.js               — Express + HTTP server entry
│   ├── .env.example
│   ├── package.json
│   └── render.yaml                — Render deployment config
│
└── frontend/
    ├── index.html                 — Complete frontend (zero dependencies)
    ├── vite.config.js
    ├── package.json
    ├── vercel.json
    └── .env.example
```

---

## ⚡ Quick Start (Local)

### Prerequisites
- **Node.js** >= 18
- **yt-dlp** installed and on PATH
  ```bash
  # Install yt-dlp
  pip install yt-dlp
  # or
  brew install yt-dlp   # macOS
  # or download binary from https://github.com/yt-dlp/yt-dlp/releases
  ```

### Backend
```bash
cd backend
npm install
cp .env.example .env
# Edit .env if needed
npm run dev
# Runs on http://localhost:3001
```

### Frontend
```bash
cd frontend
npm install
cp .env.example .env
# Edit VITE_API_URL and VITE_WS_URL if needed
npm run dev
# Runs on http://localhost:5173
```

---

## 🚀 Deployment

### Backend → Render

1. Push `backend/` to a GitHub repo
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo
4. Set environment variables:
   - `ALLOWED_ORIGINS` = your Vercel frontend URL (e.g. `https://batchdl.vercel.app`)
   - `YTDLP_PATH` = `yt-dlp` (Render installs it via pip in build command)
   - Optionally: `MAX_CONCURRENT`, `MAX_URLS_PER_BATCH`
5. Build Command: `npm install && pip install yt-dlp`
6. Start Command: `npm start`

Or use the included `render.yaml` for infrastructure-as-code deployment.

### Frontend → Vercel

1. Push `frontend/` to a GitHub repo (can be the same monorepo)
2. Go to [vercel.com](https://vercel.com) → New Project → Import repo
3. Set environment variables:
   - `VITE_API_URL` = your Render backend URL (e.g. `https://batchdl-api.onrender.com`)
   - `VITE_WS_URL` = same but with `wss://` prefix
4. Framework: Vite / Other
5. Deploy

---

## 🏗 Architecture

### Performance Design

| Concern | Solution |
|---------|----------|
| Concurrency | In-memory queue, max 2–3 parallel |
| Storage | Temp files auto-deleted 2 min after access |
| Deduplication | URL+format+quality key prevents re-download |
| Streaming | Files streamed directly to client, not buffered |
| ZIP | Generated on-demand, lazy |
| Single file | Skip ZIP, stream directly |

### Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/batch` | Submit URLs for download |
| GET | `/api/download/:jobId` | Stream file to client |
| POST | `/api/download-zip/:sessionId` | Bundle all done → ZIP |
| GET | `/api/session/:sessionId/status` | Poll all job statuses |
| POST | `/api/metadata` | Fetch title/duration only |
| POST | `/api/playlist` | Expand playlist to URLs |
| POST | `/api/retry-failed/:sessionId` | Retry all failed jobs |
| GET | `/api/stats` | Queue stats |
| GET | `/health` | Health check |

### WebSocket Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `subscribe` | Client → Server | `{ sessionId }` |
| `job_start` | Server → Client | `{ jobId }` |
| `job_progress` | Server → Client | `{ jobId, percent, speed, eta }` |
| `job_complete` | Server → Client | `{ jobId, filename, size, title }` |
| `job_fail` | Server → Client | `{ jobId, error }` |
| `stats` | Server → Client | `{ queued, running, completed, failed }` |

---

## 🔧 Environment Variables

### Backend
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `MAX_CONCURRENT` | `3` | Parallel downloads |
| `MAX_URLS_PER_BATCH` | `20` | Max URLs per request |
| `DOWNLOAD_TIMEOUT_MS` | `300000` | Per-download timeout (5min) |
| `FILE_TTL_MS` | `120000` | Auto-delete delay after download |
| `TEMP_DIR` | `/tmp/batch-dl` | Temp file directory |
| `YTDLP_PATH` | `yt-dlp` | Path to yt-dlp binary |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS origins (comma-separated) |

### Frontend
| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3001` | Backend base URL |
| `VITE_WS_URL` | `ws://localhost:3001` | WebSocket URL |

---

## ✨ Features

- **Multi-URL batch** (up to 20 per batch)
- **Format**: MP4 / MP3
- **Quality**: 360p / 720p / 1080p (video), 128/192/320kbps (audio)
- **Smart Mode**: Auto-selects best quality/speed balance
- **Quick Download Mode**: Instantly downloads each file when complete
- **Playlist expansion**: Preview + select playlist items before download
- **Real-time progress**: WebSocket updates (speed, ETA, percent)
- **Deduplication**: Same URL+settings skips reprocessing
- **Retry Failed**: One-click retry of all failed jobs
- **ZIP download**: Bundle all completed files
- **Auto-delete**: Files removed 2 min after download
- **Rate limiting**: 50 requests per 15 minutes per IP
- **Dark/light mode**: Persisted in localStorage
- **Drag & drop**: Drop .txt files to load URLs
- **Zero heavy deps** on frontend: pure HTML/CSS/JS

---

## 📝 Notes

- yt-dlp must be installed on the server. On Render, include `pip install yt-dlp` in your build command.
- Files are stored temporarily in `/tmp/batch-dl` and auto-deleted after 2 minutes — no persistent storage needed.
- For Supabase integration (optional analytics/job history), set `SUPABASE_URL` and `SUPABASE_ANON_KEY` and extend `downloads.js`.
