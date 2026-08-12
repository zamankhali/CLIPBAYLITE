const YOUTUBE_URL_RE =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]{6,}/i;

export function isValidYoutubeUrl(url) {
  return typeof url === 'string' && YOUTUBE_URL_RE.test(url.trim());
}

/**
 * Accepts "MM:SS", "H:MM:SS", or a plain number of seconds. Returns seconds
 * as a number, or null if it can't be parsed.
 */
export function parseTimestamp(input) {
  if (typeof input === 'number') return input;
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);

  const parts = trimmed.split(':').map((p) => p.trim());
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;

  const nums = parts.map(Number);
  if (nums.length === 2) {
    const [m, s] = nums;
    return m * 60 + s;
  }
  if (nums.length === 3) {
    const [h, m, s] = nums;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

const ALLOWED_QUALITIES = ['480', '720', '1080', 'best'];

/**
 * Validates a requested quality value against the allowed set and the
 * video's actual max height (so nobody can request "1080" on a video
 * that's only 480p and get a confusing result). Returns the numeric
 * height to pass to yt-dlp, or null for "best available" (no cap).
 * Returns undefined if the input is invalid.
 */
export function resolveQuality(requested, maxHeight, minQualityHeight = 480) {
  const value = (requested || 'best').toString().toLowerCase();
  if (!ALLOWED_QUALITIES.includes(value)) return undefined;

  if (value === 'best') return null;

  const height = parseInt(value, 10);
  if (height < minQualityHeight) return undefined;
  if (height > maxHeight) return null; // requested more than the source has -- just give best available
  return height;
}
