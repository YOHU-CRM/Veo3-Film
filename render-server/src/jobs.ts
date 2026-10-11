import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { JobInfo, JobStatus, RenderManifest } from '../../shared/render/types';
import { renderMovie, type RenderOutput } from './render';
import { UserError } from './proc';

export const WORK_ROOT = process.env.RENDER_WORK_DIR || path.join(os.tmpdir(), 'yohu-render');
const CONCURRENCY = Math.max(1, parseInt(process.env.RENDER_CONCURRENCY || '1', 10) || 1);
/** Giữ kết quả bao lâu sau khi xong (phút) */
const KEEP_MINUTES = parseInt(process.env.RENDER_KEEP_MINUTES || '120', 10) || 120;

interface Job {
  id: string;
  dir: string;
  status: JobStatus;
  percent: number;
  message: string;
  warnings: string[];
  error?: string;
  output?: RenderOutput;
  manifest: RenderManifest;
  files: Map<string, string>;
  abort: AbortController;
  touchedAt: number;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let running = 0;

fs.mkdirSync(WORK_ROOT, { recursive: true });

export function newJobId(): string {
  return crypto.randomBytes(9).toString('hex');
}

export function jobDir(id: string): string {
  return path.join(WORK_ROOT, id);
}

export function createJob(id: string, manifest: RenderManifest, files: Map<string, string>): Job {
  const job: Job = {
    id,
    dir: jobDir(id),
    status: 'queued',
    percent: 0,
    message: 'Đang chờ đến lượt dựng...',
    warnings: [],
    manifest,
    files,
    abort: new AbortController(),
    touchedAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(id);
  setImmediate(pump);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function toInfo(job: Job): JobInfo {
  const ahead = job.status === 'queued' ? queue.indexOf(job.id) + running : 0;
  return {
    id: job.id,
    status: job.status,
    percent: Math.round(job.percent),
    message: job.status === 'queued' && ahead > 0 ? `Đang chờ đến lượt (còn ${ahead} phim phía trước)...` : job.message,
    warnings: job.warnings,
    error: job.error,
    result: job.output && {
      duration: Math.round(job.output.duration * 10) / 10,
      sizeMB: Math.round((job.output.sizeBytes / 1048576) * 10) / 10,
      width: job.output.width,
      height: job.output.height,
    },
  };
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.abort.abort();
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  if (job.status === 'queued' || job.status === 'running') {
    job.status = 'cancelled';
    job.message = 'Đã hủy.';
  }
  removeDir(job.dir);
  jobs.delete(id);
  return true;
}

function removeDir(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* bỏ qua */ }
}

async function pump(): Promise<void> {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    running++;
    void run(job).finally(() => { running--; void pump(); });
  }
}

async function run(job: Job): Promise<void> {
  job.status = 'running';
  job.message = 'Bắt đầu dựng phim...';
  try {
    job.output = await renderMovie({
      dir: job.dir,
      manifest: job.manifest,
      files: job.files,
      signal: job.abort.signal,
      report: (percent, message) => {
        job.percent = Math.max(job.percent, Math.min(99, percent));
        job.message = message;
        job.touchedAt = Date.now();
      },
      warn: message => { job.warnings.push(message); },
    });
    job.status = 'done';
    job.percent = 100;
    job.message = 'Dựng phim thành công!';
  } catch (err: any) {
    if (job.abort.signal.aborted || err?.message === 'ABORTED') return; // đã hủy
    job.status = 'error';
    if (err instanceof UserError) {
      job.error = err.message;
    } else {
      console.error(`[job ${job.id}] lỗi:`, err?.message || err);
      if (err?.ffmpegLog) console.error(String(err.ffmpegLog));
      job.error = 'Máy dựng gặp lỗi khi xử lý video. Hãy thử lại; nếu vẫn lỗi, kiểm tra các file video/voice có mở được trên máy không.';
    }
    job.message = 'Dựng phim thất bại.';
    removeDir(job.dir);
  } finally {
    job.touchedAt = Date.now();
  }
}

/** Dọn các job cũ + thư mục mồ côi (sau khi khởi động lại máy) */
export function sweep(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const idle = now - job.touchedAt;
    if ((job.status === 'done' || job.status === 'error') && idle > KEEP_MINUTES * 60_000) {
      removeDir(job.dir);
      jobs.delete(id);
    }
  }
  try {
    for (const name of fs.readdirSync(WORK_ROOT)) {
      if (jobs.has(name)) continue;
      const p = path.join(WORK_ROOT, name);
      const age = now - fs.statSync(p).mtimeMs;
      if (age > 6 * 3600_000) removeDir(p);
    }
  } catch { /* bỏ qua */ }
}
