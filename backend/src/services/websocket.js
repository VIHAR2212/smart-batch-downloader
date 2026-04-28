// src/services/websocket.js
const WebSocket = require('ws');
const queue = require('./queue');

let wss = null;
// sessionId -> Set of ws connections
const sessionClients = new Map();

function init(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let sessionId = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.sessionId) {
          sessionId = msg.sessionId;
          if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set());
          sessionClients.get(sessionId).add(ws);
          // Send current stats immediately
          broadcast(sessionId, { type: 'stats', data: queue.getStats() });
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      if (sessionId && sessionClients.has(sessionId)) {
        sessionClients.get(sessionId).delete(ws);
        if (sessionClients.get(sessionId).size === 0) sessionClients.delete(sessionId);
      }
    });

    ws.on('error', () => {});
  });

  // Hook queue events
  queue.on('start', (jobId) => {
    const job = findJobSession(jobId);
    if (job) broadcast(job.sessionId, { type: 'job_start', jobId });
  });

  queue.on('progress', (jobId, progress) => {
    const job = findJobSession(jobId);
    if (job) broadcast(job.sessionId, { type: 'job_progress', jobId, ...progress });
  });

  queue.on('complete', (jobId, result) => {
    const job = findJobSession(jobId);
    if (job) {
      broadcast(job.sessionId, {
        type: 'job_complete',
        jobId,
        filename: result.filename,
        size: result.size,
        title: result.meta?.title,
      });
      broadcast(job.sessionId, { type: 'stats', data: queue.getStats() });
    }
  });

  queue.on('fail', (jobId, error) => {
    const job = findJobSession(jobId);
    if (job) {
      broadcast(job.sessionId, { type: 'job_fail', jobId, error });
      broadcast(job.sessionId, { type: 'stats', data: queue.getStats() });
    }
  });
}

// Map jobId -> sessionId (set when job is created)
const jobSessions = new Map();

function registerJob(jobId, sessionId) {
  jobSessions.set(jobId, sessionId);
}

function findJobSession(jobId) {
  const sessionId = jobSessions.get(jobId);
  if (!sessionId) return null;
  return { sessionId };
}

function broadcast(sessionId, data) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  if (!wss) return;
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

module.exports = { init, registerJob, broadcast, broadcastToAll };
