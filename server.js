const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

if (fs.existsSync(path.join(__dirname, '.env'))) {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

cloudinary.config();

/* ------------------------------------------------------------------ */
/* Firebase Firestore (metadata for songs, movies, messages)          */
/* ------------------------------------------------------------------ */
const DB_URL = process.env.DB_URL;

let useFirebase = false;
let dbRef = null;
let memoryDb = { songs: [], movies: [], links: [], messages: [] }; // fallback when not configured

function resolveServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const pathList = [process.env.FIREBASE_SERVICE_ACCOUNT_PATH, process.env.GOOGLE_APPLICATION_CREDENTIALS];
  for (const p of pathList) {
    if (p && fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  return null;
}

function initFirebase() {
  let serviceAccount = null;
  try {
    serviceAccount = resolveServiceAccount();
  } catch (e) {
    console.error('[Firebase] Invalid service account:', e.message);
  }

  if (!serviceAccount) {
    const msg = '[Firebase] Missing FIREBASE_SERVICE_ACCOUNT. ' +
      'Set the FIREBASE_SERVICE_ACCOUNT env var (a JSON string) on your hosting platform ' +
      '(Render -> Environment -> FIREBASE_SERVICE_ACCOUNT). Data lives in Firestore and will be LOST if Firebase is not configured.';
    if (isProduction()) {
      console.error(msg);
      console.error('[Firebase] Aborting startup: refusing to run with non-persistent in-memory storage in production.');
      process.exit(1);
    }
    console.warn(msg + ' Falling back to LOCAL in-memory storage (dev only, data will NOT persist).');
    return;
  }
  if (!DB_URL) {
    const msg = '[Firebase] Missing DB_URL. Set the DB_URL env var (your Firestore databaseURL).';
    if (isProduction()) {
      console.error(msg);
      console.error('[Firebase] Aborting startup: refusing to run with non-persistent storage in production.');
      process.exit(1);
    }
    console.warn(msg);
    return;
  }
  try {
    const firebaseApp = admin.initializeApp({ credential: admin.cert(serviceAccount), databaseURL: DB_URL });
    dbRef = require('firebase-admin/firestore').getFirestore(firebaseApp)
      .collection('studio').doc('data');
    useFirebase = true;
    console.log('[Firebase] Connected to Firestore (persistent cloud storage).');
  } catch (e) {
    console.error('[Firebase] Failed to initialize:', e.message);
    if (isProduction()) {
      console.error('[Firebase] Aborting startup: refusing to run with non-persistent storage in production.');
      process.exit(1);
    }
  }
}
initFirebase();

function isProduction() {
  return process.env.NODE_ENV === 'production' || !!process.env.RENDER || !!process.env.VERCEL || process.env.PORT === '10000';
}

async function getDb() {
  if (useFirebase) {
    const doc = await dbRef.get();
    const val = doc.exists ? doc.data() : {};
    return {
      songs: Array.isArray(val.songs) ? val.songs : [],
      movies: Array.isArray(val.movies) ? val.movies : [],
      links: Array.isArray(val.links) ? val.links : [],
      messages: Array.isArray(val.messages) ? val.messages : []
    };
  }
  return {
    songs: Array.isArray(memoryDb.songs) ? memoryDb.songs : [],
    movies: Array.isArray(memoryDb.movies) ? memoryDb.movies : [],
    links: Array.isArray(memoryDb.links) ? memoryDb.links : [],
    messages: Array.isArray(memoryDb.messages) ? memoryDb.messages : []
  };
}

async function saveDb(data) {
  if (useFirebase) {
    await dbRef.set({ songs: data.songs || [], movies: data.movies || [], links: data.links || [], messages: data.messages || [] });
  } else {
    memoryDb = { songs: data.songs || [], movies: data.movies || [], links: data.links || [], messages: data.messages || [] };
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "azim123";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2048 * 1024 * 1024 } });

const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const mediaList = (type, db) => {
  if (type === 'link' || type === 'links') return db.links;
  return (type === 'movie' || type === 'movies' ? db.movies : db.songs);
};
const isMediaType = (type) => type === 'song' || type === 'songs' || type === 'movie' || type === 'movies' || type === 'link' || type === 'links';

const cloudinaryPublicId = (url) => {
  if (!url || typeof url !== 'string' || !url.includes('res.cloudinary.com')) return null;
  const m = url.match(/\/upload\/(?:v\d+\/)?([^\/?#]+)/);
  if (!m) return null;
  return m[1].replace(/\.[^.]+$/, '');
};

const destroyCloudinaryMedia = (item) => {
  const jobs = [];
  const push = (url, rtype) => {
    const pid = cloudinaryPublicId(url);
    if (pid) jobs.push(new Promise((resolve) => {
      cloudinary.uploader.destroy(pid, { resource_type: rtype }, () => resolve());
    }));
  };
  push(item.songUrl || item.movieUrl, 'video');
  push(item.url, 'raw');
  push(item.thumbnailUrl, 'image');
  return Promise.all(jobs);
};

const uploadToCloudinary = (file, resourceType, cb) => {
  if (!file) return cb(null, '');
  const stream = cloudinary.uploader.upload_stream({ resource_type: resourceType }, (err, result) => {
    cb(err || null, result ? result.secure_url : '');
  });
  streamifier.createReadStream(file.buffer).pipe(stream);
};

/* ------------------------------------------------------------------ */
/* Public data / library                                               */
/* ------------------------------------------------------------------ */
app.get('/api/data', async (req, res) => {
  res.json(await getDb());
});

app.get('/api/tracks', async (req, res) => {
  res.json((await getDb()).songs);
});

app.get('/api/movies', async (req, res) => {
  res.json((await getDb()).movies);
});

app.get('/api/links', async (req, res) => {
  res.json((await getDb()).links);
});

/* ------------------------------------------------------------------ */
/* Admin verification                                                  */
/* ------------------------------------------------------------------ */
app.post('/api/verify-admin', (req, res) => {
  const { adminSecret } = req.body;
  if (adminSecret === ADMIN_SECRET) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

/* ------------------------------------------------------------------ */
/* Professional upload — file upload (used with XHR progress)          */
/* ------------------------------------------------------------------ */
app.post(
  '/api/upload',
  upload.fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 }
  ]),
  async (req, res) => {
    const type = isMediaType(req.body.type) && (req.body.type === 'movie' || req.body.type === 'movies') ? 'movie' : 'song';
    const mediaFile = req.files && req.files.mediaFile && req.files.mediaFile[0];
    if (!mediaFile) return res.status(400).json({ success: false, error: 'No media file received.' });

    const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];
    uploadToCloudinary(mediaFile, 'video', async (mediaErr, mediaUrl) => {
      if (mediaErr) return res.status(500).json({ success: false, error: 'Cloudinary upload failed: ' + mediaErr.message });

      uploadToCloudinary(thumbnailFile, 'image', async (thumbErr, thumbUrl) => {
        if (thumbErr) return res.status(500).json({ success: false, error: 'Cloudinary upload failed: ' + thumbErr.message });

        try {
          const db = await getDb();
          const item = {
            id: makeId(),
            title: String(req.body.title || mediaFile.originalname || 'Untitled').trim(),
            uploader: String(req.body.uploader || 'Anonymous').trim(),
            thumbnailUrl: thumbUrl || (req.body.thumbnailUrl || ''),
            createdAt: new Date().toISOString()
          };

          if (type === 'movie') {
            item.movieUrl = mediaUrl;
            db.movies.unshift(item);
          } else {
            item.songUrl = mediaUrl;
            db.songs.unshift(item);
          }
          await saveDb(db);
          res.json({ success: true, type, item });
        } catch (e) {
          res.status(500).json({ success: false, error: e.message || 'Failed to save.' });
        }
      });
    });
  }
);

/* Legacy single-file upload routes (kept for compatibility) */
app.post(
  '/api/upload/song',
  upload.fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 }
  ]),
  async (req, res) => {
    const mediaFile = req.files && req.files.mediaFile && req.files.mediaFile[0];
    if (!mediaFile) return res.status(400).send('No file uploaded.');

    const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];
    uploadToCloudinary(mediaFile, 'video', async (mediaErr, mediaUrl) => {
      if (mediaErr) return res.status(500).send('Cloudinary upload failed: ' + mediaErr.message);

      uploadToCloudinary(thumbnailFile, 'image', async (thumbErr, thumbUrl) => {
        if (thumbErr) return res.status(500).send('Cloudinary upload failed: ' + thumbErr.message);

        try {
          const db = await getDb();
          const item = {
            id: makeId(),
            title: String(req.body.title || mediaFile.originalname).trim(),
            uploader: String(req.body.uploader || 'Anonymous').trim(),
            songUrl: mediaUrl,
            thumbnailUrl: thumbUrl || (req.body.thumbnailUrl || ''),
            createdAt: new Date().toISOString()
          };
          db.songs.unshift(item);
          await saveDb(db);
          res.send('Song uploaded successfully!');
        } catch (e) {
          res.status(500).send(e.message || 'Failed to save.');
        }
      });
    });
  }
);

app.post(
  '/api/upload/movie',
  upload.fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 }
  ]),
  async (req, res) => {
    const mediaFile = req.files && req.files.mediaFile && req.files.mediaFile[0];
    if (!mediaFile) return res.status(400).send('No file uploaded.');

    const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];
    uploadToCloudinary(mediaFile, 'video', async (mediaErr, mediaUrl) => {
      if (mediaErr) return res.status(500).send('Cloudinary upload failed: ' + mediaErr.message);

      uploadToCloudinary(thumbnailFile, 'image', async (thumbErr, thumbUrl) => {
        if (thumbErr) return res.status(500).send('Cloudinary upload failed: ' + thumbErr.message);

        try {
          const db = await getDb();
          const item = {
            id: makeId(),
            title: String(req.body.title || mediaFile.originalname).trim(),
            uploader: String(req.body.uploader || 'Anonymous').trim(),
            movieUrl: mediaUrl,
            thumbnailUrl: thumbUrl || (req.body.thumbnailUrl || ''),
            createdAt: new Date().toISOString()
          };
          db.movies.unshift(item);
          await saveDb(db);
          res.send('Movie uploaded successfully!');
        } catch (e) {
          res.status(500).send(e.message || 'Failed to save.');
        }
      });
    });
  }
);

/* ------------------------------------------------------------------ */
/* Link upload — admin only, optional thumbnail file                   */
/* ------------------------------------------------------------------ */
app.post('/api/upload/link', upload.single('thumbnailFile'), async (req, res) => {
  const { title, uploader, mediaUrl, thumbnailUrl, type, adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!mediaUrl) return res.status(400).json({ success: false, error: 'Missing media URL.' });

  const item = {
    id: makeId(),
    title: String(title || 'Untitled').trim(),
    uploader: String(uploader || 'Admin').trim(),
    createdAt: new Date().toISOString()
  };

  const finish = async () => {
    try {
      const db = await getDb();
      if (type === 'movie' || type === 'movies') {
        item.movieUrl = mediaUrl;
        db.movies.unshift(item);
      } else {
        item.songUrl = mediaUrl;
        db.songs.unshift(item);
      }
      await saveDb(db);
      res.json({ success: true, type: type === 'movie' || type === 'movies' ? 'movie' : 'song', item });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || 'Failed to save.' });
    }
  };

  if (req.file) {
    uploadToCloudinary(req.file, 'image', async (err, url) => {
      if (err) return res.status(500).json({ success: false, error: 'Cloudinary upload failed: ' + err.message });
      item.thumbnailUrl = url || (thumbnailUrl || '');
      await finish();
    });
  } else {
    item.thumbnailUrl = thumbnailUrl || '';
    await finish();
  }
});

/* ------------------------------------------------------------------ */
/* Links library upload — title, URL, optional thumbnail (file/URL)   */
/* ------------------------------------------------------------------ */
app.post('/api/upload/link-item', upload.single('thumbnailFile'), async (req, res) => {
  const { title, url, uploader, thumbnailUrl } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'Missing download URL.' });

  const item = {
    id: makeId(),
    title: String(title || 'Untitled').trim(),
    url: String(url).trim(),
    uploader: String(uploader || 'Anonymous').trim(),
    createdAt: new Date().toISOString()
  };

  if (thumbnailUrl && typeof thumbnailUrl === 'string') item.thumbnailUrl = String(thumbnailUrl).trim();

  const finish = async () => {
    try {
      const db = await getDb();
      db.links.unshift(item);
      await saveDb(db);
      res.json({ success: true, type: 'link', item });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || 'Failed to save.' });
    }
  };

  if (req.file) {
    uploadToCloudinary(req.file, 'image', async (err, url) => {
      if (err) return res.status(500).json({ success: false, error: 'Cloudinary upload failed: ' + err.message });
      item.thumbnailUrl = url || (thumbnailUrl || '');
      await finish();
    });
  } else {
    await finish();
  }
});

/* ------------------------------------------------------------------ */
/* Media management (rename / delete)                                  */
/* ------------------------------------------------------------------ */
const canManage = (item, uploader, adminSecret) =>
  adminSecret === ADMIN_SECRET || (item && item.uploader === uploader);

app.put('/api/media/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!isMediaType(type)) return res.status(400).json({ success: false, error: 'Invalid type.' });

  const { newTitle, uploader, adminSecret } = req.body;
  const db = await getDb();
  const list = mediaList(type, db);
  const item = list.find((i) => i.id === id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
  if (!canManage(item, uploader, adminSecret)) return res.status(403).json({ success: false, error: 'Unauthorized' });

  item.title = String(newTitle || item.title).trim();
  await saveDb(db);
  res.json({ success: true, item });
});

app.delete('/api/media/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!isMediaType(type)) return res.status(400).json({ success: false, error: 'Invalid type.' });

  const { uploader, adminSecret } = req.body || {};
  const db = await getDb();
  const list = mediaList(type, db);
  const item = list.find((i) => i.id === id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
  if (!canManage(item, uploader, adminSecret)) return res.status(403).json({ success: false, error: 'Unauthorized' });

  const idx = list.indexOf(item);
  list.splice(idx, 1);
  await saveDb(db);
  await destroyCloudinaryMedia(item);
  res.json({ success: true });
});

/* Legacy JSON rename/delete routes (kept for compatibility) */
app.post('/api/rename', async (req, res) => {
  const { type, id, newTitle, uploader, adminSecret } = req.body;
  const db = await getDb();
  const list = mediaList(type, db);
  const item = list.find((i) => i.id === id);
  if (!item) return res.status(404).send('Not found');
  if (!canManage(item, uploader, adminSecret)) return res.status(403).send('Unauthorized');
  item.title = String(newTitle || item.title).trim();
  await saveDb(db);
  res.sendStatus(200);
});

app.post('/api/delete', async (req, res) => {
  const { type, id, uploader, adminSecret } = req.body;
  const db = await getDb();
  const list = mediaList(type, db);
  const item = list.find((i) => i.id === id);
  if (!item) return res.sendStatus(404);
  if (!canManage(item, uploader, adminSecret)) return res.sendStatus(403);
  list.splice(list.indexOf(item), 1);
  await saveDb(db);
  await destroyCloudinaryMedia(item);
  res.sendStatus(200);
});

/* ------------------------------------------------------------------ */
/* Community chat                                                      */
/* ------------------------------------------------------------------ */
app.get('/api/messages', async (req, res) => {
  res.json({ messages: (await getDb()).messages });
});

app.post('/api/messages', async (req, res) => {
  const user = String(req.body.user || 'Anonymous').trim();
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'Message cannot be empty.' });
  if (text.length > 2000) return res.status(400).json({ success: false, error: 'Message is too long.' });

  const db = await getDb();
  const message = {
    id: makeId(),
    user,
    text,
    timestamp: Date.now()
  };
  db.messages.push(message);
  if (db.messages.length > 500) db.messages = db.messages.slice(-500);
  await saveDb(db);
  res.json({ success: true, message });
});

app.post('/api/messages/clear', async (req, res) => {
  const { adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const db = await getDb();
  db.messages = [];
  await saveDb(db);
  res.json({ success: true });
});

/* ------------------------------------------------------------------ */
/* Error handling for multer                                           */
/* ------------------------------------------------------------------ */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'File is too large.' });
  }
  console.error(err);
  res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
