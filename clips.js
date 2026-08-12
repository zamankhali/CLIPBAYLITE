import { Router } from 'express';
import archiver from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { isValidYoutubeUrl, parseTimestamp, resolveQuality } from '../services/validate.js';
import { fetchVideoMeta, downloadClip, cleanupJobDir, MIN_QUALITY_HEIGHT } from '../services/cutter.js';
import { rateLimit } from '../services/rateLimit.js';

export const clipsRouter = Router();

const MAX_CLIP_SECONDS = 10 * 60; // per-clip cap
const MAX_CLIPS_PER_REQUEST = 20;

/**
 * POST /api/clips
 * body: { youtubeUrl, clips: [{ start, end }, ...], quality }  -- up to 20 entries
 * quality: "480" | "720" | "1080" | "best" (default "best"), applies to all clips in the batch
 *
 * Cuts each requested range from the same source video, then zips all
 * resulting clips into one file so the browser only has to handle a
 * single download regardless of how many clips were requested.
 *
 * NOTE: clips are cut one at a time, not in parallel -- on a free-tier
 * host with limited CPU, running 20 ffmpeg/yt-dlp jobs at once would
 * likely exhaust memory and fail everything. Sequential is slower per
 * request but far more reliable at this hosting tier.
 */
clipsRouter.post('/clips', rateLimit, async (req, res) => {
  const { youtubeUrl, clips, quality } = req.body || {};

  if (!isValidYoutubeUrl(youtubeUrl)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }
  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'Provide at least one clip.' });
  }
  if (clips.length > MAX_CLIPS_PER_REQUEST) {
    return res.status(422).json({ error: `Max ${MAX_CLIPS_PER_REQUEST} clips per request.` });
  }

  const parsedClips = [];
  for (let i = 0; i < clips.length; i++) {
    const { start, end } = clips[i];
    const startSeconds = parseTimestamp(start);
    const endSeconds = parseTimestamp(end);
    if (startSeconds === null || endSeconds === null) {
      return res.status(400).json({ error: `Clip ${i + 1}: timestamps must look like MM:SS.` });
    }
    if (endSeconds <= startSeconds) {
      return res.status(400).json({ error: `Clip ${i + 1}: end time must be after start time.` });
    }
    if (endSeconds - startSeconds > MAX_CLIP_SECONDS) {
      return res.status(422).json({
        error: `Clip ${i + 1} is too long. Max length is ${MAX_CLIP_SECONDS / 60} minutes.`,
      });
    }
    parsedClips.push({ startSeconds, endSeconds });
  }

  let meta;
  try {
    meta = await fetchVideoMeta(youtubeUrl);
  } catch (err) {
    console.error('fetchVideoMeta failed:', err);
    return res.status(422).json({ error: "Couldn't read that video. Check the link and try again." });
  }

  const overLength = parsedClips.find((c) => c.endSeconds > meta.durationSeconds);
  if (overLength) {
    return res.status(422).json({
      error: `One of your end times is past the end of the video (${Math.round(meta.durationSeconds)}s long).`,
    });
  }

  const qualityHeight = resolveQuality(quality, meta.maxHeight, MIN_QUALITY_HEIGHT);
  if (qualityHeight === undefined) {
    return res.status(400).json({ error: `Quality must be ${MIN_QUALITY_HEIGHT}p or higher.` });
  }

  const jobId = uuidv4();
  const cutPaths = [];

  try {
    for (let i = 0; i < parsedClips.length; i++) {
      const { startSeconds, endSeconds } = parsedClips[i];
      const clipPath = await downloadClip(
        youtubeUrl,
        startSeconds,
        endSeconds,
        `${jobId}-${i + 1}`,
        qualityHeight
      );
      cutPaths.push(clipPath);
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="clips.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      throw err;
    });
    archive.pipe(res);

    cutPaths.forEach((p, i) => {
      archive.file(p, { name: `clip-${i + 1}.mp4` });
    });

    await archive.finalize();

    cutPaths.forEach((_, i) => cleanupJobDir(`${jobId}-${i + 1}`));
  } catch (err) {
    console.error(`[job ${jobId}] failed:`, err);
    cutPaths.forEach((_, i) => cleanupJobDir(`${jobId}-${i + 1}`));
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Could not cut those clips. Please try again.' });
    }
    res.end();
  }
});
