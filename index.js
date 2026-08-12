import express from 'express';
import cors from 'cors';
import { clipRouter } from './routes/clip.js';
import { clipsRouter } from './routes/clips.js';
import { metaRouter } from './routes/meta.js';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', clipRouter);
app.use('/api', clipsRouter);
app.use('/api', metaRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`ClipBay Lite server listening on :${PORT}`);
});
