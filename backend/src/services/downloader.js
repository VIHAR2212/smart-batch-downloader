// src/services/downloader.js
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

// Ensure temp dir
if (!fs.existsSync(config.TEMP_DIR)) {
  fs.mkdirSync(config.TEMP_DIR, { recursive: true });
}

// Track temp files for cleanup
const tempFiles = new Map(); // filePath -> timeout

function scheduleDeletion(filePath, ttl = config.FILE_TTL_MS) {
  if (tempFiles.has(filePath)) clearTimeout(tempFiles.get(filePath));
  const t = setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
    tempFiles.delete(filePath);
  }, ttl);
  tempFiles.set(filePath, t);
}

function deleteNow(filePath) {
  if (tempFiles.has(filePath)) {
    clearTimeout(tempFiles.get(filePath));
    tempFiles.delete(filePath);
  }
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

function getFormatString(format, quality, smartMode = false) {
  if (format === 'mp3') {
    const bitrate = smartMode ? '192' : quality.replace('kbps', '');
    return { extractAudio: true, audioFormat: 'mp3', audioBitrate: bitrate };
  }
  // mp4
  const heightMap = { '360p': 360, '720p': 720, '1080p': 1080 };
  let height = heightMap[quality] || (smartMode ? 720 : 720);
  return { videoFormat: `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`, height };
}

async function fetchMetadata(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-playlist',
      '--socket-timeout', '15',
      url
    ];

    const proc = execFile(config.YTDLP_PATH, args, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Metadata fetch failed: ${stderr || err.message}`));
      try {
        const data = JSON.parse(stdout.trim().split('\n')[0]);
        resolve({
          title: sanitizeFilename(data.title || 'untitled'),
          duration: data.duration || 0,
          thumbnail: data.thumbnail || null,
          uploader: data.uploader || '',
          formats: data.formats || [],
        });
      } catch (e) {
        reject(new Error('Failed to parse metadata'));
      }
    });
  });
}

async function fetchPlaylistMetadata(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--flat-playlist',
      '--socket-timeout', '15',
      url
    ];

    const chunks = [];
    const proc = spawn(config.YTDLP_PATH, args);
    proc.stdout.on('data', d => chunks.push(d.toString()));
    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      try {
        const lines = chunks.join('').trim().split('\n').filter(Boolean);
        const items = lines.map(l => {
          try {
            const d = JSON.parse(l);
            return { url: d.url || d.webpage_url, title: d.title, duration: d.duration };
          } catch (_) { return null; }
        }).filter(Boolean);
        resolve(items);
      } catch (e) {
        reject(new Error('Failed to parse playlist'));
      }
    });
    proc.on('error', reject);
  });
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100) || 'download';
}

async function downloadFile(url, format, quality, smartMode, onProgress) {
  const meta = await fetchMetadata(url);
  const fmtOpts = getFormatString(format, quality, smartMode);
  const ext = format === 'mp3' ? 'mp3' : 'mp4';
  const filename = `${meta.title}.${ext}`;
  const outPath = path.join(config.TEMP_DIR, `${uuidv4()}_${filename}`);

  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--socket-timeout', '30',
      '-o', outPath,
    ];

    if (format === 'mp3') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', fmtOpts.audioBitrate + 'k');
    } else {
      args.push('-f', fmtOpts.videoFormat, '--merge-output-format', 'mp4');
    }

    args.push(url);

    const proc = spawn(config.YTDLP_PATH, args);
    let lastProgress = { percent: 0, speed: '', eta: '' };
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Download timed out'));
    }, config.DOWNLOAD_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      const str = data.toString();
      // Parse yt-dlp progress lines: [download]  XX.X% of XX at XX/s ETA XX:XX
      const match = str.match(/\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\w+\/s).*?ETA\s+([\d:]+)/);
      if (match) {
        lastProgress = { percent: parseFloat(match[1]), speed: match[2], eta: match[3] };
        onProgress(lastProgress);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Try to clean up partial files
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
        return reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-300)}`));
      }

      // yt-dlp sometimes changes extension; check for actual output
      let actualPath = outPath;
      if (!fs.existsSync(outPath)) {
        // Common: yt-dlp writes .mp4 even if we said mp3 (before conversion)
        const dir = path.dirname(outPath);
        const base = path.basename(outPath, `.${ext}`);
        const candidates = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(outPath, `.${ext}`)));
        if (candidates.length > 0) actualPath = path.join(dir, candidates[0]);
        else return reject(new Error('Output file not found after download'));
      }

      const stat = fs.statSync(actualPath);
      scheduleDeletion(actualPath);
      resolve({ path: actualPath, filename, size: stat.size, meta });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}. Is yt-dlp installed?`));
    });
  });
}

function streamToResponse(filePath, filename, res, onSent) {
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found or already deleted' });
    return;
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.zip': 'application/zip' };
  const mime = mimeMap[ext] || 'application/octet-stream';

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', stat.size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('end', () => {
    if (onSent) onSent();
    deleteNow(filePath);
  });
  stream.on('error', () => {
    res.destroy();
    deleteNow(filePath);
  });
}

module.exports = { downloadFile, fetchMetadata, fetchPlaylistMetadata, streamToResponse, deleteNow, scheduleDeletion };
