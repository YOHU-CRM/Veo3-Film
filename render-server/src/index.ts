/**
 * YOHU Render Server – máy dựng video tự động (FFmpeg, miễn phí, chạy cục bộ hoặc trên VPS).
 *
 *   GET    /health            -> trạng thái máy dựng
 *   POST   /jobs              -> upload (multipart) + bắt đầu dựng
 *   GET    /jobs/:id          -> tiến độ
 *   GET    /jobs/:id/result   -> xem / tải MP4 (?download=1 để tải)
 *   DELETE /jobs/:id          -> hủy / xóa
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';

import type { RenderManifest } from '../../shared/render/types';
import { FFMPEG, FFPROBE } from './binaries';
import { cancelJob, createJob, getJob, jobDir, newJobId, sweep, toInfo, WORK_ROOT } from './jobs';
import { runProcess } from './proc';
import { imagesSupported } from './imageScene';

const PORT = parseInt(process.env.PORT || '5055', 10);
const HOST = process.env.HOST || '127.0.0.1'; // chỉ máy này truy cập được. VPS: đặt HOST=0.0.0.0
const TOKEN = process.env.RENDER_TOKEN || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_FILE_BYTES = 8 * 1024 ** 3;
const MAX_FILES = 800;

const app = express();
app.disable('x-powered-by');

// ── CORS + Private Network Access (để web trên Vercel gọi được máy dựng ở localhost) ──
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

// ── Xác thực (chỉ khi đặt RENDER_TOKEN, dùng cho VPS) ──
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!TOKEN || req.path === '/health') return next();
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const query = typeof req.query.t === 'string' ? req.query.t : '';
  if (bearer === TOKEN || query === TOKEN) return next();
  res.status(401).json({ error: 'Sai hoặc thiếu mã truy cập máy dựng.' });
});

let capabilities: { ffmpeg: string; subtitles: boolean; sidechain: boolean; images: boolean } | null = null;
async function detectCapabilities() {
  if (capabilities) return capabilities;
  const ver = await runProcess(FFMPEG, ['-hide_banner', '-version'], { collectStdout: true }).catch(() => null);
  const filters = await runProcess(FFMPEG, ['-hide_banner', '-filters'], { collectStdout: true }).catch(() => null);
  capabilities = {
    ffmpeg: ver?.stdout.split('\n')[0]?.trim() || 'không tìm thấy',
    subtitles: !!filters && /\bass\b/.test(filters.stdout),
    sidechain: !!filters && /sidechaincompress/.test(filters.stdout),
    images: imagesSupported(),
  };
  return capabilities;
}

app.get('/health', async (_req, res) => {
  const caps = await detectCapabilities();
  res.json({
    ok: caps.ffmpeg !== 'không tìm thấy',
    engine: 'yohu-ffmpeg',
    version: 1,
    cpus: os.cpus().length,
    authRequired: !!TOKEN,
    ...caps,
  });
});

// ── Upload ──
function assignJobId(req: Request, _res: Response, next: NextFunction) {
  const id = newJobId();
  (req as any).jobId = id;
  fs.mkdirSync(path.join(jobDir(id), 'in'), { recursive: true });
  next();
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, path.join(jobDir((req as any).jobId), 'in')),
  filename: (_req, file, cb) => {
    // Tên lưu = tên field (an toàn) + đuôi file gốc
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    cb(null, file.fieldname.replace(/[^a-zA-Z0-9_\-]/g, '_') + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fieldSize: 5 * 1024 * 1024 },
});

function validateManifest(raw: unknown): RenderManifest {
  const m = raw as RenderManifest;
  if (!m || typeof m !== 'object' || !Array.isArray(m.scenes) || !m.settings) {
    throw new Error('Dữ liệu yêu cầu không hợp lệ.');
  }
  if (m.scenes.length === 0) throw new Error('Chưa có cảnh nào để dựng.');
  const s = m.settings;
  if (!['original', '16:9', '9:16', '1:1'].includes(s.aspectRatio)) throw new Error('Tỉ lệ khung hình không hợp lệ.');
  if (!['blur', 'cover', 'contain'].includes(s.fitMode)) throw new Error('Chế độ khớp khung không hợp lệ.');
  if (!['original', '720p', '1080p', '4k'].includes(s.quality)) throw new Error('Chất lượng không hợp lệ.');
  if (!['yellow_stroke', 'white_box'].includes(s.subtitleStyle)) throw new Error('Kiểu phụ đề không hợp lệ.');
  for (const sc of m.scenes) {
    if (typeof sc.id !== 'string' || !/^[a-zA-Z0-9_\-]+$/.test(sc.id)) throw new Error('Mã cảnh không hợp lệ.');
    if (sc.kind !== undefined && sc.kind !== 'video' && sc.kind !== 'image') throw new Error('Loại cảnh không hợp lệ.');
    if (sc.imageDuration !== undefined && !(typeof sc.imageDuration === 'number' && sc.imageDuration > 0 && sc.imageDuration <= 600)) throw new Error('Thời lượng ảnh không hợp lệ.');
    if (sc.motionStyle !== undefined && !['auto', 'text-safe', 'kenburns', 'none'].includes(sc.motionStyle)) throw new Error('Kiểu chuyển động không hợp lệ.');
  }
  return m;
}

app.post('/jobs', assignJobId, (req: Request, res: Response) => {
  const id: string = (req as any).jobId;
  const fail = (status: number, message: string) => {
    try { fs.rmSync(jobDir(id), { recursive: true, force: true }); } catch { /* bỏ qua */ }
    if (!res.headersSent) res.status(status).json({ error: message });
  };
  // Người dùng đóng tab giữa chừng -> dọn dẹp
  req.on('aborted', () => { try { fs.rmSync(jobDir(id), { recursive: true, force: true }); } catch { /* bỏ qua */ } });

  upload.any()(req, res, err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Một file vượt quá giới hạn dung lượng của máy dựng.'
        : err.code === 'LIMIT_FILE_COUNT' ? 'Tải lên quá nhiều file cùng lúc.'
        : 'Tải file lên máy dựng bị gián đoạn. Hãy thử lại.';
      return fail(400, msg);
    }
    let manifest: RenderManifest;
    try {
      manifest = validateManifest(JSON.parse(String(req.body?.manifest ?? 'null')));
    } catch (e: any) {
      return fail(400, e?.message || 'Dữ liệu yêu cầu không hợp lệ.');
    }

    const files = new Map<string, string>();
    for (const f of (req.files as Express.Multer.File[]) ?? []) files.set(f.fieldname, f.path);

    createJob(id, manifest, files);
    res.status(202).json({ id });
  });
});

app.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ error: 'Không tìm thấy tác vụ (có thể đã hết hạn).' });
  res.json(toInfo(job));
});

app.get('/jobs/:id/result', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== 'done' || !job.output) {
    return void res.status(404).json({ error: 'Chưa có kết quả hoặc kết quả đã hết hạn.' });
  }
  job.touchedAt = Date.now();
  const download = req.query.download === '1';
  const name = String(req.query.name || 'Phim_AI').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80) || 'Phim_AI';
  res.setHeader('Content-Type', 'video/mp4');
  if (download) res.setHeader('Content-Disposition', `attachment; filename="${name}.mp4"`);
  res.sendFile(job.output.outputPath); // hỗ trợ Range -> tua video mượt, không tốn RAM
});

app.delete('/jobs/:id', (req, res) => {
  res.json({ ok: cancelJob(req.params.id) });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Lỗi máy chủ:', err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: 'Máy dựng gặp lỗi không mong muốn.' });
});

export const server = app.listen(PORT, HOST, async () => {
  const caps = await detectCapabilities();
  console.log('');
  console.log('  ✅ MÁY DỰNG VIDEO YOHU ĐANG CHẠY');
  console.log(`  Địa chỉ : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  FFmpeg  : ${caps.ffmpeg}`);
  console.log(`  Phụ đề  : ${caps.subtitles ? 'OK' : 'KHÔNG CÓ (FFmpeg thiếu libass)'}`);
  console.log(`  Thư mục : ${WORK_ROOT}`);
  console.log(`  Mã truy cập: ${TOKEN ? 'BẬT' : 'tắt (chỉ nên dùng khi chạy trên máy cá nhân)'}`);
  console.log('  Giữ cửa sổ này mở trong khi dựng phim. Nhấn Ctrl+C để tắt.');
  console.log('');
});
server.requestTimeout = 0;      // upload file lớn có thể mất nhiều phút
server.headersTimeout = 60_000;

sweep();
setInterval(sweep, 10 * 60_000).unref();

// Bảo vệ: không để 1 lỗi bất ngờ làm sập cả máy dựng
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('uncaughtException', e => console.error('uncaughtException:', e));

export { FFPROBE };
