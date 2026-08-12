import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const TMP_DIR = path.resolve(process.env.TMP_DIR || './tmp');

// Minimum floor -- we never offer anything below this, per spec.
export const MIN_QUALITY_HEIGHT = 480;

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

/**
 * Returns duration plus the highest video height actually available for
 * this video (e.g. 1080, 1440, 2160 for 4K), so the frontend can offer a
 * quality dropdown that never promises a resolution the source doesn't have.
 */
export async function fetchVideoMeta(youtubeUrl) {
  const { stdout } = await runYtDlp([
    '--dump-json',
    '--no-playlist',
    '--skip-download',
    youtubeUrl,
  ]);
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
 * locally. This keeps bandwidth/time small regardless of how long the
 * source video is.
 *
 * qualityHeight: target max height (e.g. 480, 720, 1080, 2160). Pass
 * null/undefined for "best available" with no cap.
 *
 * Note: because this cuts at the download level (not a local ffmpeg
 * re-encode), the exact start point can land on the nearest keyframe
 * rather than the exact frame -- usually within a second, good enough
 * for "grab this part of the video" use, not frame-accurate editing.
 */
export async function downloadClip(youtubeUrl, startSeconds, endSeconds, jobId, qualityHeight) {
  const jobDir = path.join(TMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const outputTemplate = path.join(jobDir, 'clip.%(ext)s');
  const section = `*${startSeconds}-${endSeconds}`;

  const heightFilter = qualityHeight ? `[height<=${qualityHeight}]` : '';
  const formatSelector = `bv*${heightFilter}+ba/b${heightFilter}`;

  await runYtDlp([
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
  ]);

  const expectedPath = path.join(jobDir, 'clip.mp4');
  if (!fs.existsSync(expectedPath)) {
    throw new Error('yt-dlp reported success but the expected clip file is missing.');
  }
  return expectedPath;
}

export function cleanupJobDir(jobId) {
  const dir = path.join(TMP_DIR, jobId);
  fs.rm(dir, { recursive: true, force: true }, () => {});
}
