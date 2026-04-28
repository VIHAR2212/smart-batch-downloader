// src/utils/validate.js

const SUPPORTED_DOMAINS = [
  'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com',
  'soundcloud.com', 'twitter.com', 'x.com', 'instagram.com',
  'facebook.com', 'fb.watch', 'tiktok.com', 'bilibili.com',
  'twitch.tv', 'reddit.com', 'v.redd.it', 'rumble.com',
  'odysee.com', 'lbry.tv', 'bandcamp.com', 'mixcloud.com',
  'open.spotify.com', 'music.youtube.com',
];

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isSupportedUrl(str) {
  try {
    const url = new URL(str);
    const host = url.hostname.replace(/^www\./, '');
    return SUPPORTED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

function parseUrls(raw) {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !l.startsWith('#'));
}

function deduplicateUrls(urls) {
  return [...new Set(urls)];
}

module.exports = { isValidUrl, isSupportedUrl, parseUrls, deduplicateUrls };
