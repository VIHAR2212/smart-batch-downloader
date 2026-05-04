// src/services/downloader.js
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

if (!fs.existsSync(config.TEMP_DIR)) {
  fs.mkdirSync(config.TEMP_DIR, { recursive: true });
}

const COOKIE_PATH = path.join(__dirname, '..', '..', 'cookies.txt');

function ensureCookies() {
  if (fs.existsSync(COOKIE_PATH)) {
    console.log('✅ Cookies file found at:', COOKIE_PATH, 'size:', fs.statSync(COOKIE_PATH).size);
  } else {
    console.log('❌ Cookies file NOT found at:', COOKIE_PATH);
  }
}
ensureCookies();

function getCookieArgs() {
  try {
    if (fs.existsSync(COOKIE_PATH) && fs.statSync(COOKIE_PATH).size > 10) {
      return ['--cookies', COOKIE_PATH];
    }
  } catch (_) {}
  return [];
}

function getBypassArgs() {
  return [
    '--no-check-certificates',
    '--extractor-retries', '3',
    '--retry-sleep', '3',
    '--socket-timeout', '30',
    '--user-agent', 'com.google.ios.youtube/19.29.1 CFNetwork/1410.0.3 Darwin/22.6.0',
    '--extractor-args', 'youtube:player_client=ios',
    ...getCookieArgs(),
  ];
}

const tempFiles = new Map();
function scheduleDeletion(filePath, ttl = config.FILE_TTL_MS) {
  if (tempFiles.has(filePath)) clearTimeout(tempFiles.get(filePath));
  const t = setTimeout(() => {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
    tempFiles.delete(filePath);
  }, ttl);
  tempFiles.set(filePath, t);
}
function deleteNow(filePath) {
  if (tempFiles.has(filePath)) { clearTimeout(tempFiles.get(filePath)); tempFiles.delete(filePath); }
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

function sanitizeFilename(name) {
  return (name || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100) || 'download';
}

function getFormatString(format, quality, smartMode = false) {
  if (format === 'mp3') {
    const bitrate = smartMode ? '192' : quality.replace('kbps', '');
    return { audioBitrate: bitrate };
  }
  const heightMap = { '360p': 360, '720p': 720, '1080p': 1080 };
  const height = heightMap[quality] || 720;
  return {
    videoFormat: `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
  };
}

async function searchVideos(query, platform = 'youtube', limit = 5) {
  const prefix = platform === 'soundcloud' ? 'scsearch' : 'ytsearch';
  const searchQuery = `${prefix}${limit}:${query}`;
  return new Promise((resolve) => {
    const args = [
      '--dump-json', '--no-playlist', '--flat-playlist',
      '--socket-timeout', '20',
      '--extractor-args', 'youtube:player_client=ios',
      '--user-agent', 'com.google.ios.youtube/19.29.1 CFNetwork/1410.0.3 Darwin/22.6.0',
      ...getCookieArgs(),
      searchQuery,
    ];
    const chunks = [];
    const proc = spawn(config.YTDLP_PATH, args);
    proc.stdout.on('data', d => chunks.push(d.toString()));
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      try {
        const results = chunks.join('').trim().split('\n').filter(Boolean).map(l => {
          try {
            const d = JSON.parse(l);
            return {
              title: d.title || 'Unknown',
              url: d.webpage_url || d.url || '',
              duration: d.duration || 0,
              uploader: d.uploader || d.channel || '',
              thumbnail: d.thumbnail || '',
              platform: platform === 'soundcloud' ? 'SoundCloud' : 'YouTube',
            };
          } catch (_) { return null; }
        }).filter(Boolean).filter(r => r.url);
        resolve(results);
      } catch (e) { resolve([]); }
    });
    proc.on('error', () => resolve([]));
    setTimeout(() => { try { proc.kill(); } catch (_) {} }, 25000);
  });
}

async function fetchMetadata(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-playlist', ...getBypassArgs(), url];
    execFile(config.YTDLP_PATH, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Metadata fetch failed: ${stderr.slice(-200) || err.message}`));
      try {
        const data = JSON.parse(stdout.trim().split('\n')[0]);
        resolve({
          title: sanitizeFilename(data.title || 'untitled'),
          duration: data.duration || 0,
          thumbnail: data.thumbnail || null,
          uploader: data.uploader || '',
        });
      } catch (e) { reject(new Error('Failed to parse metadata')); }
    });
  });
}

async function fetchPlaylistMetadata(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--flat-playlist', ...getBypassArgs(), url];
    const chunks = [];
    const proc = spawn(config.YTDLP_PATH, args);
    proc.stdout.on('data', d => chunks.push(d.toString()));
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      try {
        const items = chunks.join('').trim().split('\n').filter(Boolean).map(l => {
          try {
            const d = JSON.parse(l);
            return { url: d.url || d.webpage_url, title: d.title, duration: d.duration };
          } catch (_) { return null; }
        }).filter(Boolean);
        resolve(items);
      } catch (e) { reject(new Error('Failed to parse playlist')); }
    });
    proc.on('error', reject);
  });
}

async function downloadFile(url, format, quality, smartMode, onProgress) {
  // Clean YouTube URL — remove playlist params
  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  const videoId = isYouTube ? url.match(/(?:v=|youtu\.be\/)([^&\n?#]+)/)?.[1] : null;
  const finalUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;

  const meta = await fetchMetadata(finalUrl);
  const fmtOpts = getFormatString(format, quality, smartMode);
  const ext = format === 'mp3' ? 'mp3' : 'mp4';
  const filename = `${meta.title}.${ext}`;
  const outPath = path.join(config.TEMP_DIR, `${uuidv4()}_${filename}`);

  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '-o', outPath, ...getBypassArgs()];
    if (format === 'mp3') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', fmtOpts.audioBitrate + 'k');
    } else {
      args.push('-f', fmtOpts.videoFormat, '--merge-output-format', 'mp4');
    }
    args.push(finalUrl);

    const proc = spawn(config.YTDLP_PATH, args);
    let stderr = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Download timed out')); }, config.DOWNLOAD_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      const str = data.toString();
      const match = str.match(/\[download\]\s+([\d.]+)%.*?at\s+([\d.a-zA-Z\/]+).*?ETA\s+([\d:]+)/);
      if (match) onProgress({ percent: parseFloat(match[1]), speed: match[2], eta: match[3] });
    });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
        return reject(new Error(`yt-dlp failed: ${stderr.slice(-400)}`));
      }
      let actualPath = outPath;
      if (!fs.existsSync(outPath)) {
        const dir = path.dirname(outPath);
        const candidates = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(outPath, `.${ext}`)));
        if (candidates.length > 0) actualPath = path.join(dir, candidates[0]);
        else return reject(new Error('Output file not found'));
      }
      const stat = fs.statSync(actualPath);
      scheduleDeletion(actualPath);
      resolve({ path: actualPath, filename, size: stat.size, meta });
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)); });
  });
}

function streamToResponse(filePath, filename, res, onSent) {
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found or already deleted' }); return; }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.zip': 'application/zip' };
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('end', () => { if (onSent) onSent(); deleteNow(filePath); });
  stream.on('error', () => { res.destroy(); deleteNow(filePath); });
}

module.exports = { downloadFile, fetchMetadata, fetchPlaylistMetadata, searchVideos, streamToResponse, deleteNow, scheduleDeletion };
