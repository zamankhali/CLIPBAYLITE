import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { isValidYoutubeUrl, parseTimestamp, resolveQuality } from '../services/validate.js';
import { fetchVideoMeta, downloadClip, cleanupJobDir, MIN_QUALITY_HEIGHT } from '../services/cutter.js';
import { rateLimit } from '../services/rateLimit.js';

export const clipRouter = Router();

const MAX_CLIP_SECONDS = 10 * 60; // 10-minute cap per clip, keeps this cheap to run on a free host

/**
 * POST /api/clip
 * body: { youtubeUrl, start, end, quality }
 *   start/end: "MM:SS", "H:MM:SS", or seconds
 *   quality: "480" | "720" | "1080" | "best" (default "best")
 *
 * Downloads just that time range and streams the resulting mp4 straight
 * back as the response -- no storage bucket needed, since the file only
 * needs to exist long enough to reach the browser.
 */
clipRouter.post('/clip', rateLimit, async (req, res) => {
  const { youtubeUrl, start, end, quality } = req.body || {};

  if (!isValidYoutubeUrl(youtubeUrl)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  const startSeconds = parseTimestamp(start);
  const endSeconds = parseTimestamp(end);

  if (startSeconds === null || endSeconds === null) {
    return res.status(400).json({ error: 'Timestamps must look like MM:SS or H:MM:SS.' });
  }
  if (endSeconds <= startSeconds) {
    return res.status(400).json({ error: 'End time must be after start time.' });
  }
  if (endSeconds - startSeconds > MAX_CLIP_SECONDS) {
    return res.status(422).json({
      error: `Clip is too long. Max length is ${MAX_CLIP_SECONDS / 60} minutes.`,
    });
  }

  let meta;
  try {
    meta = await fetchVideoMeta(youtubeUrl);
  } catch (err) {
    console.error('fetchVideoMeta failed:', err);
    return res.status(422).json({ error: "Couldn't read that video. Check the link and try again." });
  }

  if (endSeconds > meta.durationSeconds) {
    return res.status(422).json({
      error: `That end time is past the end of the video (${Math.round(meta.durationSeconds)}s long).`,
    });
  }

  const qualityHeight = resolveQuality(quality, meta.maxHeight, MIN_QUALITY_HEIGHT);
  if (qualityHeight === undefined) {
    return res.status(400).json({ error: `Quality must be ${MIN_QUALITY_HEIGHT}p or higher.` });
  }

  const jobId = uuidv4();
  try {
    const clipPath = await downloadClip(youtubeUrl, startSeconds, endSeconds, jobId, qualityHeight);

    res.download(clipPath, 'clip.mp4', (err) => {
      cleanupJobDir(jobId);
      if (err) console.error(`[job ${jobId}] failed to send file:`, err);
    });
  } catch (err) {
    console.error(`[job ${jobId}] failed:`, err);
    cleanupJobDir(jobId);
    return res.status(500).json({ error: 'Could not cut that clip. Please try again.' });
  }
});
