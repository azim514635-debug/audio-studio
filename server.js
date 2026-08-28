const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const fs = require('fs');
const path = require('path');

if (fs.existsSync(path.join(__dirname, '.env'))) {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

cloudinary.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "azim123";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2048 * 1024 * 1024 } });

const DB_FILE = 'database.json';
function getDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ songs: [], movies: [], messages: [] }, null, 2));
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      songs: raw.songs || [],
      movies: raw.movies || [],
      messages: raw.messages || []
    };
  } catch (e) {
    return { songs: [], movies: [], messages: [] };
  }
}
function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const mediaList = (type, db) => (type === 'movie' || type === 'movies' ? db.movies : db.songs);
const isMediaType = (type) => type === 'song' || type === 'songs' || type === 'movie' || type === 'movies';

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
app.get('/api/data', (req, res) => {
  res.json(getDb());
});

app.get('/api/tracks', (req, res) => {
  res.json(getDb().songs);
});

app.get('/api/movies', (req, res) => {
  res.json(getDb().movies);
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
/* multipart fields: type, title, uploader, thumbnailUrl,              */
/* files: mediaFile, thumbnailFile (both optional single)              */
/* ------------------------------------------------------------------ */
app.post(
  '/api/upload',
  upload.fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 }
  ]),
  (req, res) => {
    const type = isMediaType(req.body.type) && (req.body.type === 'movie' || req.body.type === 'movies') ? 'movie' : 'song';
    const mediaFile = req.files && req.files.mediaFile && req.files.mediaFile[0];
    if (!mediaFile) return res.status(400).json({ success: false, error: 'No media file received.' });

    const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];
    const mediaResource = type === 'movie' ? 'video' : 'video';
    uploadToCloudinary(mediaFile, mediaResource, (mediaErr, mediaUrl) => {
      if (mediaErr) return res.status(500).json({ success: false, error: 'Cloudinary upload failed: ' + mediaErr.message });

      uploadToCloudinary(thumbnailFile, 'image', (thumbErr, thumbUrl) => {
        if (thumbErr) return res.status(500).json({ success: false, error: 'Cloudinary upload failed: ' + thumbErr.message });

        const db = getDb();
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
        saveDb(db);
        res.json({ success: true, type, item });
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
  (req, res) => {
    const mediaFile = req.files && req.files.mediaFile && req.files.mediaFile[0];
    if (!mediaFile) return res.status(400).send('No file uploaded.');

    const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];
    uploadToCloudinary(mediaFile, 'video', (mediaErr, mediaUrl) => {
      if (mediaErr) return res.status(500).send('Cloudinary upload failed: ' + mediaErr.message);

      uploadToCloudinary(thumbnailFile, 'image', (thumbErr, thumbUrl) => {
        if (thumbErr) return res.status(500).send('Cloudinary upload failed: ' + thumbErr.message);

        const db = getDb();
        const item = {
          id: makeId(),
          title: String(req.body.title || mediaFile.originalname).trim(),
          uploader: String(req.body.uploader || 'Anonymous').trim(),
          songUrl: mediaUrl,
          thumbnailUrl: thumbUrl || (req.body.thumbnailUrl || ''),
          createdAt: new Date().toISOString()
        };
        db.songs.unshift(item);
        saveDb(db);
        res.send('Song uploaded successfully!');
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
  (req, res) => {
    const mediaFile = req.files && req.files.mediaFile && req.files.mediaFile[0];
    if (!mediaFile) return res.status(400).send('No file uploaded.');

    const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];
    uploadToCloudinary(mediaFile, 'video', (mediaErr, mediaUrl) => {
      if (mediaErr) return res.status(500).send('Cloudinary upload failed: ' + mediaErr.message);

      uploadToCloudinary(thumbnailFile, 'image', (thumbErr, thumbUrl) => {
        if (thumbErr) return res.status(500).send('Cloudinary upload failed: ' + thumbErr.message);

        const db = getDb();
        const item = {
          id: makeId(),
          title: String(req.body.title || mediaFile.originalname).trim(),
          uploader: String(req.body.uploader || 'Anonymous').trim(),
          movieUrl: mediaUrl,
          thumbnailUrl: thumbUrl || (req.body.thumbnailUrl || ''),
          createdAt: new Date().toISOString()
        };
        db.movies.unshift(item);
        saveDb(db);
        res.send('Movie uploaded successfully!');
      });
    });
  }
);

/* ------------------------------------------------------------------ */
/* Link upload — admin only, optional thumbnail file                   */
/* Accepts JSON body or multipart (so a thumbnail file may be attached) */
/* ------------------------------------------------------------------ */
app.post('/api/upload/link', upload.single('thumbnailFile'), (req, res) => {
  const { title, uploader, mediaUrl, thumbnailUrl, type, adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!mediaUrl) return res.status(400).json({ success: false, error: 'Missing media URL.' });

  const db = getDb();
  const item = {
    id: makeId(),
    title: String(title || 'Untitled').trim(),
    uploader: String(uploader || 'Admin').trim(),
    createdAt: new Date().toISOString()
  };

  const finish = () => {
    if (type === 'movie' || type === 'movies') {
      item.movieUrl = mediaUrl;
      db.movies.unshift(item);
    } else {
      item.songUrl = mediaUrl;
      db.songs.unshift(item);
    }
    saveDb(db);
    res.json({ success: true, type: type === 'movie' || type === 'movies' ? 'movie' : 'song', item });
  };

  if (req.file) {
    uploadToCloudinary(req.file, 'image', (err, url) => {
      if (err) return res.status(500).json({ success: false, error: 'Cloudinary upload failed: ' + err.message });
      item.thumbnailUrl = url || (thumbnailUrl || '');
      finish();
    });
  } else {
    item.thumbnailUrl = thumbnailUrl || '';
    finish();
  }
});

/* ------------------------------------------------------------------ */
/* Media management (rename / delete)                                  */
/* ------------------------------------------------------------------ */
const canManage = (item, uploader, adminSecret) =>
  adminSecret === ADMIN_SECRET || (item && item.uploader === uploader);

app.put('/api/media/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (!isMediaType(type)) return res.status(400).json({ success: false, error: 'Invalid type.' });

  const { newTitle, uploader, adminSecret } = req.body;
  const db = getDb();
  const list = mediaList(type, db);
  const item = list.find((i) => i.id === id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
  if (!canManage(item, uploader, adminSecret)) return res.status(403).json({ success: false, error: 'Unauthorized' });

  item.title = String(newTitle || item.title).trim();
  saveDb(db);
  res.json({ success: true, item });
});

app.delete('/api/media/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (!isMediaType(type)) return res.status(400).json({ success: false, error: 'Invalid type.' });

  const { uploader, adminSecret } = req.body || {};
  const db = getDb();
  const list = mediaList(type, db);
  const item = list.find((i) => i.id === id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found.' });
  if (!canManage(item, uploader, adminSecret)) return res.status(403).json({ success: false, error: 'Unauthorized' });

  const idx = list.indexOf(item);
  list.splice(idx, 1);
  saveDb(db);
  res.json({ success: true });
});

/* Legacy JSON rename/delete routes (kept for compatibility) */
app.post('/api/rename', (req, res) => {
  const { type, id, newTitle, uploader, adminSecret } = req.body;
  const db = getDb();
  const list = mediaList(type, db);
  const item = list.find((i) => i.id === id);
  if (!item) return res.status(404).send('Not found');
  if (!canManage(item, uploader, adminSecret)) return res.status(403).send('Unauthorized');
  item.title = String(newTitle || item.title).trim();
  saveDb(db);
  res.sendStatus(200);
});

app.post('/api/delete', (req, res) => {
  const { type, id, uploader, adminSecret } = req.body;
  const db = getDb();
  const list = mediaList(type, db);
  const item = list.find((i) => i.id === id);
  if (!item) return res.status(404).send('Not found');
  if (!canManage(item, uploader, adminSecret)) return res.status(403).send('Unauthorized');
  list.splice(list.indexOf(item), 1);
  saveDb(db);
  res.sendStatus(200);
});

/* ------------------------------------------------------------------ */
/* Community chat                                                      */
/* ------------------------------------------------------------------ */
app.get('/api/messages', (req, res) => {
  res.json({ messages: getDb().messages });
});

app.post('/api/messages', (req, res) => {
  const user = String(req.body.user || 'Anonymous').trim();
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'Message cannot be empty.' });
  if (text.length > 2000) return res.status(400).json({ success: false, error: 'Message is too long.' });

  const db = getDb();
  const message = {
    id: makeId(),
    user,
    text,
    timestamp: Date.now()
  };
  db.messages.push(message);
  if (db.messages.length > 500) db.messages = db.messages.slice(-500);
  saveDb(db);
  res.json({ success: true, message });
});

app.post('/api/messages/clear', (req, res) => {
  const { adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const db = getDb();
  db.messages = [];
  saveDb(db);
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