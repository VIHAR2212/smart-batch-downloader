// src/services/queue.js
const { EventEmitter } = require('events');
const { MAX_CONCURRENT } = require('../config');

class DownloadQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.running = new Map(); // jobId -> job
    this.completed = new Map(); // jobId -> result
    this.failed = new Map(); // jobId -> error
    this.dedupMap = new Map(); // urlKey -> jobId (for dedup)
    this.maxConcurrent = MAX_CONCURRENT;
  }

  _urlKey(url, format, quality) {
    return `${url}|${format}|${quality}`;
  }

  add(job) {
    const key = this._urlKey(job.url, job.format, job.quality);

    // Deduplication: if same url+settings already queued/running/done, reuse
    if (this.dedupMap.has(key)) {
      const existingId = this.dedupMap.get(key);
      if (this.completed.has(existingId)) {
        return { jobId: existingId, deduped: true, cached: true };
      }
      if (this.running.has(existingId) || this.queue.find(j => j.id === existingId)) {
        return { jobId: existingId, deduped: true, cached: false };
      }
    }

    this.dedupMap.set(key, job.id);
    this.queue.push(job);
    this._drain();
    return { jobId: job.id, deduped: false, cached: false };
  }

  _drain() {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      this._run(job);
    }
  }

  async _run(job) {
    this.running.set(job.id, job);
    this.emit('start', job.id);

    try {
      const result = await job.execute((progress) => {
        this.emit('progress', job.id, progress);
      });

      this.running.delete(job.id);
      this.completed.set(job.id, result);
      this.emit('complete', job.id, result);
    } catch (err) {
      this.running.delete(job.id);
      this.failed.set(job.id, err.message || 'Unknown error');
      // Remove from dedup so retries work
      const key = this._urlKey(job.url, job.format, job.quality);
      this.dedupMap.delete(key);
      this.emit('fail', job.id, err.message);
    } finally {
      this._drain();
    }
  }

  getStatus(jobId) {
    if (this.completed.has(jobId)) return { state: 'complete', data: this.completed.get(jobId) };
    if (this.failed.has(jobId)) return { state: 'failed', error: this.failed.get(jobId) };
    if (this.running.has(jobId)) return { state: 'running' };
    if (this.queue.find(j => j.id === jobId)) {
      const pos = this.queue.findIndex(j => j.id === jobId);
      return { state: 'queued', position: pos + 1 };
    }
    return { state: 'unknown' };
  }

  getStats() {
    return {
      queued: this.queue.length,
      running: this.running.size,
      completed: this.completed.size,
      failed: this.failed.size,
    };
  }

  retryFailed(jobFactory) {
    const retried = [];
    for (const [jobId, error] of this.failed.entries()) {
      const newJob = jobFactory(jobId);
      if (newJob) {
        this.failed.delete(jobId);
        this.add(newJob);
        retried.push(jobId);
      }
    }
    return retried;
  }

  clearCompleted() {
    this.completed.clear();
  }
}

module.exports = new DownloadQueue();
