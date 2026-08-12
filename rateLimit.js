const hits = new Map(); // ip -> array of timestamps (ms)

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS = 10; // per IP per hour -- generous for personal use, cheap to protect a free host

/**
 * Basic IP-based rate limit. Not meant to be bulletproof (IPs are easy to
 * change) -- just enough to stop one runaway client or script from eating
 * your entire free-tier hosting allowance in a few minutes.
 */
export function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now();

  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  recent.push(now);
  hits.set(ip, recent);
  next();
}
