// src/routes/downloads.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const queue = require('../services/queue');
const { downloadFile, fetchMetadata, fetchPlaylistMetadata, streamToResponse, scheduleDeletion } = require('../services/downloader');
const ws = require('../services/websocket');
const { isValidUrl, isSupportedUrl, parseUrls, deduplicateUrls } = require('../utils/validate');
const config = require('../config');

// In-memory session job tracking
// sessionId -> [jobId, ...]
const sessionJobs = new Map();
// jobId -> { url, format, quality, smartMode, sessionId }
const jobMeta = new Map();

// POST /api/batch - submit a batch of URLs
router.post('/batch', (req, res) => {
  const { urls: rawUrls, format = 'mp4', quality = '720p', smartMode = false, sessionId } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!rawUrls) return res.status(400).json({ error: 'urls required' });

  const parsed = deduplicateUrls(parseUrls(typeof rawUrls === 'string' ? rawUrls : rawUrls.join('\n')));

  if (parsed.length === 0) return res.status(400).json({ error: 'No valid URLs provided' });
  if (parsed.length > config.MAX_URLS_PER_BATCH) {
    return res.status(400).json({ error: `Max ${config.MAX_URLS_PER_BATCH} URLs per batch` });
  }

  const jobs = [];
  const invalid = [];

  for (const url of parsed) {
    if (!isValidUrl(url)) { invalid.push({ url, reason: 'Invalid URL format' }); continue; }
    if (!isSupportedUrl(url)) { invalid.push({ url, reason: 'Unsupported domain' }); continue; }

    const jobId = uuidv4();
    const meta = { url, format, quality, smartMode, sessionId };
    jobMeta.set(jobId, meta);

    if (!sessionJobs.has(sessionId)) sessionJobs.set(sessionId, []);
    sessionJobs.get(sessionId).push(jobId);

    ws.registerJob(jobId, sessionId);

    const { jobId: finalId, deduped, cached } = queue.add({
      id: jobId,
      url, format, quality, smartMode,
      execute: (onProgress) => downloadFile(url, format, quality, smartMode, onProgress),
    });

    jobs.push({ jobId: finalId, url, deduped, cached });
  }

  res.json({ jobs, invalid, stats: queue.getStats() });
});

// GET /api/status/:jobId
router.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const status = queue.getStatus(jobId);
  res.json(status);
});

// GET /api/session/:sessionId/status - all jobs in session
router.get('/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const jobIds = sessionJobs.get(sessionId) || [];
  const statuses = jobIds.map(jobId => ({
    jobId,
    ...queue.getStatus(jobId),
    meta: jobMeta.get(jobId),
  }));
  res.json({ jobs: statuses, stats: queue.getStats() });
});

// GET /api/download/:jobId - stream file to client
router.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const status = queue.getStatus(jobId);

  if (status.state !== 'complete') {
    return res.status(425).json({ error: `Job not complete. State: ${status.state}` });
  }

  const result = status.data;
  streamToResponse(result.path, result.filename, res, () => {
    // File sent — already scheduled for deletion
  });
});

// POST /api/download-zip/:sessionId - bundle all completed into ZIP
router.post('/download-zip/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const jobIds = sessionJobs.get(sessionId) || [];

  const completed = jobIds
    .map(id => ({ id, status: queue.getStatus(id) }))
    .filter(j => j.status.state === 'complete' && j.status.data);

  if (completed.length === 0) {
    return res.status(400).json({ error: 'No completed downloads to ZIP' });
  }

  // Single file: direct download instead of ZIP
  if (completed.length === 1) {
    const result = completed[0].status.data;
    return streamToResponse(result.path, result.filename, res);
  }

  // Multi-file ZIP
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="batch-download.zip"');

  const archive = archiver('zip', { zlib: { level: 1 } }); // Low compression for speed
  archive.pipe(res);

  const addedFiles = [];
  for (const job of completed) {
    const result = job.status.data;
    if (fs.existsSync(result.path)) {
      archive.file(result.path, { name: result.filename });
      addedFiles.push(result.path);
    }
  }

  archive.finalize();

  archive.on('end', () => {
    // Cleanup files after ZIP is sent
    for (const f of addedFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  });

  archive.on('error', (err) => {
    res.destroy();
  });
});

// POST /api/metadata - fetch metadata without downloading
router.post('/metadata', async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL' });

  try {
    const meta = await fetchMetadata(url);
    res.json(meta);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// POST /api/playlist - expand playlist URLs
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
  const { sessionId } = req.params;
  const jobIds = sessionJobs.get(sessionId) || [];

  const retried = [];
  for (const jobId of jobIds) {
    const status = queue.getStatus(jobId);
    if (status.state === 'failed') {
      const meta = jobMeta.get(jobId);
      if (!meta) continue;
      const newJobId = uuidv4();
      jobMeta.set(newJobId, meta);
      ws.registerJob(newJobId, sessionId);
      sessionJobs.get(sessionId).push(newJobId);

      queue.add({
        id: newJobId,
        ...meta,
        execute: (onProgress) => downloadFile(meta.url, meta.format, meta.quality, meta.smartMode, onProgress),
      });
      retried.push({ old: jobId, new: newJobId });
    }
  }

  res.json({ retried });
});

// GET /api/stats
router.get('/stats', (req, res) => {
  res.json(queue.getStats());
});

module.exports = router;
