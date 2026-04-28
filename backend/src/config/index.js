// src/config/index.js
module.exports = {
  PORT: process.env.PORT || 3001,
  MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT || '3'),
  MAX_URLS_PER_BATCH: parseInt(process.env.MAX_URLS_PER_BATCH || '20'),
  DOWNLOAD_TIMEOUT_MS: parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '300000'), // 5min
  FILE_TTL_MS: parseInt(process.env.FILE_TTL_MS || '120000'), // 2min
  TEMP_DIR: process.env.TEMP_DIR || '/tmp/batch-dl',
  RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000, // 15min
  RATE_LIMIT_MAX: 50,
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(','),
  YTDLP_PATH: process.env.YTDLP_PATH || 'yt-dlp',
};
