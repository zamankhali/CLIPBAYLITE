# ClipBay Lite

Paste a YouTube link, type a start/end time, download that section as a
video file. No AI, no captions, no auto-crop, no accounts.

## How it's cheaper than the full version
- No OpenAI or Anthropic API — nothing here calls a paid AI model.
- No storage bucket — the cut clip streams straight to your browser and
  is deleted off the server right after.
- yt-dlp downloads *only* the requested time range, not the whole video,
  so even a 2-hour source video costs about the same as a 2-minute one.
- The only real cost left is hosting the server itself — and that's what
  a free tier can plausibly cover for light personal use.

## Deploying (phone-only, no terminal)

**1. Get the code onto GitHub**
- github.com → sign in (or sign up) → "New repository" → name it
  `clipbay-lite`
- Use "uploading an existing file" to drag in this whole folder

**2. Deploy the backend on Render's free tier**
- render.com → sign up (free) → "New" → "Web Service" → connect your
  GitHub repo → set root directory to `server`
- Render will detect the Dockerfile and build automatically
- No environment variables are required for this version — it just works
  once deployed
- Copy the URL Render gives you (something like
  `clipbay-lite.onrender.com`)

**3. Point the frontend at your backend**
- Open `client/index.html` in GitHub's web editor (tap the pencil icon)
- Find this line near the bottom:
  ```js
  const API_BASE = window.CLIPBAY_API_BASE || "http://localhost:8080";
  ```
- Right above it, add:
  ```js
  window.CLIPBAY_API_BASE = "https://YOUR-RENDER-URL-HERE";
  ```
  using the URL from step 2. Commit the change directly on github.com.

**4. Host the frontend for free**
- The simplest option: GitHub Pages. In your repo, go to Settings → Pages
  → set source to the `client` folder on your main branch → save.
  GitHub gives you a live URL in a minute or two.
- That URL is your website. Open it, paste a link, try it.

## Honest limits of the free tier
- **Render's free tier sleeps** after inactivity — the first request
  after a while can take 30–60 seconds to "wake up." Normal, not a bug.
- **Free tier has a monthly hour cap.** Fine for personal/light shared
  use; if it gets popular, you'll hit the cap and need to upgrade to a
  paid plan (a few dollars/month at that point).
- **10-minute max clip length** is set in the code (`MAX_CLIP_SECONDS`)
  specifically to keep each request light enough for a free host to
  handle without timing out.
- **Rate limited to 10 requests/hour per visitor** — protects the free
  tier from being burned through by accident or abuse. Adjust in
  `src/services/rateLimit.js` if you need to.
- **No queueing.** If two people cut clips at the exact same time on a
  free instance, both requests compete for the same limited CPU/memory —
  fine for light personal use, not built for real concurrent traffic.

## Testing before you deploy anything
If you ever do get access to a computer, even briefly, you can test this
locally first with zero hosting involved:
```
cd server
npm install
npm start
```
Then open `client/index.html` directly in a browser (API_BASE defaults
to localhost). But since you're phone-only, deploying straight to Render
as described above is the practical path — that first live test on
Render IS the first real test of this code, since nothing has run it yet.
