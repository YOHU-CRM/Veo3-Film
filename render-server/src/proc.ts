import { spawn } from 'node:child_process';

/** Lỗi có thông điệp thân thiện, hiển thị thẳng cho người dùng */
export class UserError extends Error {}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  collectStdout?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderrTail: string;
}

export function runProcess(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('ABORTED'));

    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true });
    let stdout = '';
    let stderrTail = '';
    let stdoutBuf = '';

    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* đã thoát */ } };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (opts.collectStdout) stdout += text;
      if (opts.onStdoutLine) {
        stdoutBuf += text;
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          opts.onStdoutLine(stdoutBuf.slice(0, idx).trim());
          stdoutBuf = stdoutBuf.slice(idx + 1);
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });

    child.on('error', err => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new UserError(
        `Không chạy được FFmpeg (${bin}). Hãy chạy lại "npm install" trong thư mục render-server. Chi tiết: ${err.message}`
      ));
    });
    child.on('close', code => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error('ABORTED'));
      resolve({ code: code ?? -1, stdout, stderrTail });
    });
  });
}

/** Chạy ffmpeg và báo tiến độ theo giây đã xử lý (đọc từ -progress) */
export async function runFfmpeg(
  bin: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; onSeconds?: (seconds: number) => void },
): Promise<void> {
  const full = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args];
  const res = await runProcess(bin, full, {
    cwd: opts.cwd,
    signal: opts.signal,
    onStdoutLine: line => {
      if (!opts.onSeconds) return;
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m) opts.onSeconds(parseInt(m[1], 10) / 1_000_000);
    },
  });
  if (res.code !== 0) {
    const err = new Error(`ffmpeg thoát với mã ${res.code}: ${res.stderrTail.trim()}`);
    (err as any).ffmpegLog = res.stderrTail;
    throw err;
  }
}
