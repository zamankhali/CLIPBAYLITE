import { Router } from 'express';
import { isValidYoutubeUrl } from '../services/validate.js';
import { fetchVideoMeta, MIN_QUALITY_HEIGHT } from '../services/cutter.js';
import { rateLimit } from '../services/rateLimit.js';

export const metaRouter = Router();

/**
 * POST /api/meta
 * body: { youtubeUrl }
 *
 * Looks up duration + the highest resolution actually available for this
 * video, so the frontend can build a quality dropdown that never offers
 * a resolution the source doesn't have (e.g. don't show "4K" for a video
 * that only exists in 720p).
 */
metaRouter.post('/meta', rateLimit, async (req, res) => {
  const { youtubeUrl } = req.body || {};

  if (!isValidYoutubeUrl(youtubeUrl)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const { durationSeconds, maxHeight } = await fetchVideoMeta(youtubeUrl);
    res.json({
      durationSeconds,
      maxHeight,
      minQualityHeight: MIN_QUALITY_HEIGHT,
    });
  } catch (err) {
    console.error('fetchVideoMeta failed:', err);
    res.status(422).json({ error: "Couldn't read that video. Check the link and try again." });
  }
});
