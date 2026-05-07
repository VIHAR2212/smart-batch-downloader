// src/routes/downloads.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const archiver = require('archiver');

const queue = require('../services/queue');
const { downloadFile, fetchMetadata, fetchPlaylistMetadata, searchVideos, getDirectUrls, streamToResponse } = require('../services/downloader');
const ws = require('../services/websocket');
const { isValidUrl, isSupportedUrl, parseUrls, deduplicateUrls } = require('../utils/validate');
const config = require('../config');

const sessionJobs = new Map();
const jobMeta = new Map();

// POST /api/batch - for non-YouTube (SoundCloud etc.)
router.post('/batch', (req, res) => {
  const { urls: rawUrls, format = 'mp4', quality = '720p', smartMode = false, sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!rawUrls) return res.status(400).json({ error: 'urls required' });

  const parsed = deduplicateUrls(parseUrls(typeof rawUrls === 'string' ? rawUrls : rawUrls.join('\n')));
  if (parsed.length === 0) return res.status(400).json({ error: 'No valid URLs provided' });
  if (parsed.length > config.MAX_URLS_PER_BATCH) return res.status(400).json({ error: `Max ${config.MAX_URLS_PER_BATCH} URLs per batch` });

  const jobs = [], invalid = [];

  for (const url of parsed) {
    if (!isValidUrl(url)) { invalid.push({ url, reason: 'Invalid URL' }); continue; }
    if (!isSupportedUrl(url)) { invalid.push({ url, reason: 'Unsupported domain' }); continue; }

    const jobId = uuidv4();
    const meta = { url, format, quality, smartMode, sessionId };
    jobMeta.set(jobId, meta);
    if (!sessionJobs.has(sessionId)) sessionJobs.set(sessionId, []);
    sessionJobs.get(sessionId).push(jobId);
    ws.registerJob(jobId, sessionId);

    const { jobId: finalId, deduped, cached } = queue.add({
      id: jobId, url, format, quality, smartMode,
      execute: (onProgress) => downloadFile(url, format, quality, smartMode, onProgress),
    });
    jobs.push({ jobId: finalId, url, deduped, cached });
  }
  res.json({ jobs, invalid, stats: queue.getStats() });
});

// POST /api/stream-url - KEY ENDPOINT: returns direct stream URL for client-side download
router.post('/stream-url', async (req, res) => {
  const { url, format = 'mp3', quality = '720p' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const result = await getDirectUrls(url, format, quality);
    res.json({
      directUrl: result.directUrl,
      title: result.title,
      ext: result.ext,
      isAudio: result.isAudio,
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// GET /api/status/:jobId
router.get('/status/:jobId', (req, res) => {
  res.json(queue.getStatus(req.params.jobId));
});

// GET /api/session/:sessionId/status
router.get('/session/:sessionId/status', (req, res) => {
  const jobIds = sessionJobs.get(req.params.sessionId) || [];
  const statuses = jobIds.map(jobId => ({ jobId, ...queue.getStatus(jobId), meta: jobMeta.get(jobId) }));
  res.json({ jobs: statuses, stats: queue.getStats() });
});

// GET /api/download/:jobId
router.get('/download/:jobId', (req, res) => {
  const status = queue.getStatus(req.params.jobId);
  if (status.state !== 'complete') return res.status(425).json({ error: `Job not complete. State: ${status.state}` });
  streamToResponse(status.data.path, status.data.filename, res);
});

// POST /api/download-zip/:sessionId
router.post('/download-zip/:sessionId', async (req, res) => {
  const jobIds = sessionJobs.get(req.params.sessionId) || [];
  const completed = jobIds.map(id => ({ id, status: queue.getStatus(id) })).filter(j => j.status.state === 'complete' && j.status.data);
  if (completed.length === 0) return res.status(400).json({ error: 'No completed downloads to ZIP' });
  if (completed.length === 1) return streamToResponse(completed[0].status.data.path, completed[0].status.data.filename, res);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="smartdl-batch.zip"');
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.pipe(res);
  const addedFiles = [];
  for (const job of completed) {
    const result = job.status.data;
    if (fs.existsSync(result.path)) { archive.file(result.path, { name: result.filename }); addedFiles.push(result.path); }
  }
  archive.finalize();
  archive.on('end', () => { for (const f of addedFiles) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {} } });
  archive.on('error', () => res.destroy());
});

// POST /api/metadata
router.post('/metadata', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const meta = await fetchMetadata(url);
    res.json(meta);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// POST /api/search
router.post('/search', async (req, res) => {
  const { query, platforms = ['youtube', 'soundcloud'] } = req.body;
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query too short' });
  try {
    const searches = platforms.map(p => searchVideos(query.trim(), p, 5));
    const results = await Promise.allSettled(searches);
    const items = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    res.json({ results: items, query });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/playlist
router.post('/playlist', async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const items = await fetchPlaylistMetadata(url);
    res.json({ items, count: items.length });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// POST /api/retry-failed/:sessionId
router.post('/retry-failed/:sessionId', (req, res) => {
  const jobIds = sessionJobs.get(req.params.sessionId) || [];
  const retried = [];
  for (const jobId of jobIds) {
    const status = queue.getStatus(jobId);
    if (status.state === 'failed') {
      const meta = jobMeta.get(jobId);
      if (!meta) continue;
      const newJobId = uuidv4();
      jobMeta.set(newJobId, meta);
      ws.registerJob(newJobId, meta.sessionId);
      sessionJobs.get(req.params.sessionId).push(newJobId);
      queue.add({ id: newJobId, ...meta, execute: (onProgress) => downloadFile(meta.url, meta.format, meta.quality, meta.smartMode, onProgress) });
      retried.push({ old: jobId, new: newJobId });
    }
  }
  res.json({ retried });
});

// GET /api/stats
router.get('/stats', (req, res) => res.json(queue.getStats()));

module.exports = router;
