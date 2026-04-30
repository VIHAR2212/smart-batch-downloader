// src/index.js
const http = require('http');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { limiter, strictLimiter } = require('./middleware/rateLimiter');
const downloadsRouter = require('./routes/downloads');
const wsService = require('./services/websocket');

const app = express();
const server = http.createServer(app);

// CORS — supports wildcard *
const allowedOrigins = process.env.ALLOWED_ORIGINS || '*';
app.use(cors({
  origin: (origin, cb) => {
    if (allowedOrigins === '*') return cb(null, true);
    if (!origin) return cb(null, true);
    const list = allowedOrigins.split(',').map(o => o.trim());
    if (list.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '100kb' }));
app.use(limiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// Routes
app.use('/api', downloadsRouter);
app.post('/api/batch', strictLimiter);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Init WebSocket
wsService.init(server);

server.listen(config.PORT, () => {
  console.log(`🚀 Smart Batch Downloader backend running on port ${config.PORT}`);
  console.log(`   Max concurrent: ${config.MAX_CONCURRENT}`);
  console.log(`   Max URLs/batch: ${config.MAX_URLS_PER_BATCH}`);
  console.log(`   Temp dir: ${config.TEMP_DIR}`);
});
