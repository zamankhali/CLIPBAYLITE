import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const TMP_DIR = path.resolve(process.env.TMP_DIR || './tmp');
const COOKIES_PATH = path.resolve('./cookies.txt');

// If a cookies.txt file exists, pass it to every yt-dlp call. This makes
// requests look like they're coming from a logged-in browser instead of
// an anonymous server -- needed because YouTube blocks/rate-limits plain
// requests from cloud hosting IPs (Render, AWS, etc.) with a
// "confirm you're not a bot" error.
function withCookies(args) {
  if (fs.existsSync(COOKIES_PATH)) {
    return ['--cookies', COOKIES_PATH, ...args];
  }
  console.warn('[cutter] No cookies.txt found -- requests may be blocked by YouTube.');
  return args;
}

// Minimum floor -- we never offer anything below this, per spec.
export const MIN_QUALITY_HEIGHT = 480;

// CapCut (and a lot of consumer editors) only reliably reads H.264 video +
// AAC audio inside an .mp4 container. YouTube frequently serves VP9 or AV1
// instead, especially above 1080p -- yt-dlp will happily remux that into an
// .mp4 file that LOOKS right but isn't actually H.264, and CapCut fails to
// import it. Everything below exists to guarantee true H.264/AAC output.

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(new Error(`Failed to launch yt-dlp: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(new Error(`Failed to launch ffmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
    });
  });
}

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(new Error(`Failed to launch ffprobe: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
    });
  });
}

/**
 * Inspects the actual codecs in a downloaded file (never trust the file
 * extension -- .mp4 can legally contain VP9/AV1 video).
 */
async function probeCodecs(filePath) {
  const { stdout } = await runFfprobe([
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    filePath,
  ]);
  const info = JSON.parse(stdout);
  const videoStream = (info.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (info.streams || []).find((s) => s.codec_type === 'audio');
  return {
    videoCodec: videoStream?.codec_name || null,
    audioCodec: audioStream?.codec_name || null,
  };
}

/**
 * Re-encodes in place (via a temp file) to guaranteed H.264 + AAC.
 * Only called when probeCodecs() shows the download isn't already
 * H.264/AAC, so most <=1080p YouTube sources skip this entirely.
 */
async function ensureH264Aac(filePath) {
  const { videoCodec, audioCodec } = await probeCodecs(filePath);
  const videoOk = videoCodec === 'h264';
  const audioOk = audioCodec === 'aac';

  if (videoOk && audioOk) {
    console.log(`[cutter] Already H.264/AAC (${videoCodec}/${audioCodec}), no re-encode needed.`);
    return filePath;
  }

  console.warn(
    `[cutter] Source is ${videoCodec}/${audioCodec}, not CapCut-safe -- ` +
    `re-encoding to H.264/AAC.`
  );

  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `_reencode_${Date.now()}.mp4`);

  await runFfmpeg([
    '-y',
    '-i', filePath,
    ...(videoOk ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']),
    ...(audioOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-movflags', '+faststart',
    tempPath,
  ]);

  fs.renameSync(tempPath, filePath);
  return filePath;
}

/**
 * Returns duration plus the highest video height actually available for
 * this video (e.g. 1080, 1440, 2160 for 4K), so the frontend can offer
 * a quality dropdown that never promises a resolution the source doesn't have.
 */
export async function fetchVideoMeta(youtubeUrl) {
  const { stdout } = await runYtDlp(withCookies([
    '--dump-json',
    '--no-playlist',
    '--skip-download',
    youtubeUrl,
  ]));
  const info = JSON.parse(stdout);

  const heights = (info.formats || [])
    .map((f) => f.height)
    .filter((h) => typeof h === 'number' && h > 0);
  const maxHeight = heights.length ? Math.max(...heights) : info.height || 1080;

  return {
    durationSeconds: Math.round(info.duration || 0),
    maxHeight,
  };
}

// Kept for compatibility with any existing callers expecting duration only.
export async function fetchVideoDuration(youtubeUrl) {
  const meta = await fetchVideoMeta(youtubeUrl);
  return meta.durationSeconds;
}

/**
 * Downloads ONLY the [startSeconds, endSeconds] range using yt-dlp's
 * --download-sections, rather than pulling the whole video and cutting
 * it locally. This keeps bandwidth/time small regardless of how long the
 * source video is.
 *
 * qualityHeight: target max height (e.g. 480, 720, 1080, 2160). Pass
 * null/undefined for "best available" with no cap.
 *
 * Note: because this cuts at the download level (not a local ffmpeg
 * re-encode), the exact start point can land on the nearest keyframe
 * rather than the exact frame -- usually within a second, good enough
 * for "grab this part of the video" use, not frame-accurate editing.
 *
 * Output is guaranteed H.264 video + AAC audio in an .mp4 container --
 * see ensureH264Aac() above. Format selection below prefers H.264/AAC
 * streams first (fast path, no re-encode); if YouTube only has
 * VP9/AV1 at the requested height (common above 1080p), it falls back
 * to the best available stream and ensureH264Aac() transcodes it.
 */
export async function downloadClip(youtubeUrl, startSeconds, endSeconds, jobId, qualityHeight) {
  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const outputTemplate = path.join(jobDir, 'clip.%(ext)s');
  const section = `*${startSeconds}-${endSeconds}`;

  const heightFilter = qualityHeight ? `[height<=${qualityHeight}]` : '';

  // Fallback chain, in order:
  //   1. H.264 video + AAC audio at/under the requested height (ideal, no re-encode later)
  //   2. H.264 video + any audio at/under the requested height
  //   3. Best available at/under the requested height, any codec (will be transcoded)
  const formatSelector =
    `bv*[vcodec^=avc1]${heightFilter}+ba[acodec^=mp4a]/` +
    `bv*[vcodec^=avc1]${heightFilter}+ba/` +
    `bv*${heightFilter}+ba/b${heightFilter}`;

  await runYtDlp(withCookies([
    '--no-playlist',
    '--download-sections',
    section,
    '-f',
    formatSelector,
    '--merge-output-format',
    'mp4',
    '-o',
    outputTemplate,
    youtubeUrl,
  ]));

  const expectedPath = path.join(jobDir, 'clip.mp4');
  if (!fs.existsSync(expectedPath)) {
    throw new Error('yt-dlp reported success but the expected clip file is missing.');
  }

  await ensureH264Aac(expectedPath);

  return expectedPath;
}

export function cleanupJobDir(jobId) {
  const dir = path.join(TMP_DIR, jobId);
  fs.rm(dir, { recursive: true, force: true }, () => {});
}
