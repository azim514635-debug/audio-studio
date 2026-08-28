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
    console.warn(
      '[Firebase] WARNING: FIREBASE_SERVICE_ACCOUNT is not configured. ' +
      'The app will run with LOCAL in-memory storage, so songs/movies/links/messages will NOT persist across restarts or redeploys. ' +
      'To fix, set the FIREBASE_SERVICE_ACCOUNT env var (JSON string) on your hosting platform (Render -> Environment).'
    );
    return;
  }
  if (!DB_URL) {
    console.warn(
      '[Firebase] WARNING: DB_URL is not configured. ' +
      'The app will run with LOCAL in-memory storage and data will NOT persist. ' +
      'Set the DB_URL env var (your Firestore databaseURL) on your hosting platform.'
    );
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
    console.warn('[Firebase] Running WITHOUT persistence. Check the error above and your Firebase configuration.');
  }
}
initFirebase();

async function getDb() {
  if (useFirebase) {
    const doc = await dbRef.get();
    const val = doc.exists ? doc.data() : {};
    return {
      songs: Array.isArray(val.songs) ? val.songs : [],
      movies: Array.isArray(val.movies) ? val.movies : [],
      links: Array.isArray(val.links) ? val.links : [],
      messages: Array.isArray(val.messages) ? val.messages : [],
      requests: Array.isArray(val.requests) ? val.requests : [],
      notifTokens: Array.isArray(val.notifTokens) ? val.notifTokens : []
    };
  }
  return {
    songs: Array.isArray(memoryDb.songs) ? memoryDb.songs : [],
    movies: Array.isArray(memoryDb.movies) ? memoryDb.movies : [],
    links: Array.isArray(memoryDb.links) ? memoryDb.links : [],
    messages: Array.isArray(memoryDb.messages) ? memoryDb.messages : [],
    requests: Array.isArray(memoryDb.requests) ? memoryDb.requests : [],
    notifTokens: Array.isArray(memoryDb.notifTokens) ? memoryDb.notifTokens : []
  };
}

async function saveDb(data) {
  if (useFirebase) {
    await dbRef.set({ songs: data.songs || [], movies: data.movies || [], links: data.links || [], messages: data.messages || [], requests: data.requests || [], notifTokens: data.notifTokens || [] });
  } else {
    memoryDb = { songs: data.songs || [], movies: data.movies || [], links: data.links || [], messages: data.messages || [], requests: data.requests || [], notifTokens: data.notifTokens || [] };
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
          sendUploadNotification(type, item.title, item.uploader);
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
/* Contact requests (stored server-side, notifies the boss)            */
/* ------------------------------------------------------------------ */
app.post('/api/contact', async (req, res) => {
  const user = String(req.body.user || 'Anonymous').trim();
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'Message cannot be empty.' });

  const db = await getDb();
  db.requests = db.requests || [];
  const request = { id: makeId(), user, text, createdAt: new Date().toISOString(), timestamp: Date.now() };
  db.requests.unshift(request);
  if (db.requests.length > 500) db.requests = db.requests.slice(0, 500);
  await saveDb(db);

  sendToNamedDevices('azim', '📩 Contact message from ' + user, text.slice(0, 200), { url: '/?page=admin', type: 'contact' })
    .catch(() => { /* ignore */ });

  res.json({ success: true, request });
});

app.get('/api/requests', async (req, res) => {
  const db = await getDb();
  res.json({ requests: db.requests || [] });
});

app.post('/api/requests/clear', async (req, res) => {
  const { adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const db = await getDb();
  db.requests = [];
  await saveDb(db);
  res.json({ success: true });
});

/* ------------------------------------------------------------------ */
/* "Seen by" tracking for messages and library media                   */
/* ------------------------------------------------------------------ */
app.post('/api/seen', async (req, res) => {
  const { type, id, name } = req.body;
  if (!type || !id || !name) return res.status(400).json({ success: false, error: 'Missing fields.' });
  const db = await getDb();

  let list = null;
  if (type === 'message' || type === 'messages') list = db.messages;
  else if (type === 'song' || type === 'songs') list = db.songs;
  else if (type === 'movie' || type === 'movies') list = db.movies;
  else if (type === 'link' || type === 'links') list = db.links;
  else return res.status(400).json({ success: false, error: 'Invalid type.' });

  const item = list.find((i) => i.id === id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found.' });

  item.seen = item.seen || [];
  const n = String(name);
  if (!item.seen.some((s) => String(s.name).toLowerCase() === n.toLowerCase())) {
    item.seen.push({ name: n, at: Date.now() });
  }
  await saveDb(db);
  res.json({ success: true, seen: item.seen });
});

/* ------------------------------------------------------------------ */
/* Firebase Cloud Messaging (FCM) — push notifications                 */
/* ------------------------------------------------------------------ */
const FCM_VAPID = process.env.FCM_VAPID_KEY || null;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || null;
const FIREBASE_APP_ID = process.env.FIREBASE_APP_ID || null;
const FIREBASE_MESSAGING_SENDER_ID = process.env.FIREBASE_MESSAGING_SENDER_ID || null;

app.get('/api/notify/config', (req, res) => {
  res.json({
    vapidKey: FCM_VAPID || null,
    firebaseConfig: {
      apiKey: FIREBASE_API_KEY || 'YOUR_API_KEY',
      authDomain: 'azim-studio-chat.firebaseapp.com',
      projectId: 'azim-studio-chat',
      storageBucket: 'azim-studio-chat.firebasestorage.app',
      messagingSenderId: FIREBASE_MESSAGING_SENDER_ID || 'YOUR_MESSAGING_SENDER_ID',
      appId: FIREBASE_APP_ID || 'YOUR_APP_ID'
    },
    messagingConfigured: !!(FCM_VAPID)
  });
});

function getMessaging() {
  if (!useFirebase) return null;
  try {
    return admin.messaging();
  } catch (e) {
    return null;
  }
}

/* ---- FCM device token storage (Firebase Realtime Database) ---- */
function getRtdb() {
  try {
    return admin.database();
  } catch (e) {
    return null;
  }
}

const tokenHash = (token) => {
  let h = 0;
  const s = String(token || '');
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return 't' + (h >>> 0).toString(36);
};

async function getAllTokens() {
  const rtdb = getRtdb();
  if (rtdb) {
    try {
      const snap = await rtdb.ref('fcm_tokens').once('value');
      const val = snap.val();
      if (val && typeof val === 'object') {
        return Object.values(val).filter((t) => t && t.token);
      }
      return [];
    } catch (e) { /* fall through to firestore */ }
  }
  return (await getDb()).notifTokens || [];
}

async function saveToken(token, name) {
  const rtdb = getRtdb();
  const entry = { token: String(token), name: String(name || 'Guest'), registeredAt: Date.now() };
  if (rtdb) {
    try {
      await rtdb.ref('fcm_tokens/' + tokenHash(token)).set(entry);
      return true;
    } catch (e) { /* fall through */ }
  }
  const db = await getDb();
  db.notifTokens = db.notifTokens || [];
  if (!db.notifTokens.some((t) => t.token === token)) db.notifTokens.push(entry);
  await saveDb(db);
  return true;
}

async function removeToken(token) {
  const rtdb = getRtdb();
  if (rtdb) {
    try {
      await rtdb.ref('fcm_tokens/' + tokenHash(token)).remove();
      return;
    } catch (e) { /* fall through */ }
  }
  const db = await getDb();
  db.notifTokens = (db.notifTokens || []).filter((t) => t.token !== token);
  await saveDb(db);
}

async function removeInvalidTokens(invalidTokens) {
  if (!invalidTokens || !invalidTokens.length) return;
  for (const t of invalidTokens) {
    try { await removeToken(t); } catch (e) { /* ignore */ }
  }
}

function buildNotification(title, body, data) {
  const notification = {};
  if (title) notification.title = title;
  if (body) notification.body = body;
  const payload = {};
  if (data && typeof data === 'object') {
    for (const k of Object.keys(data)) payload[k] = String(data[k]);
  }
  if (title) payload.title = title;
  if (body) payload.body = body;
  payload.icon = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQoQRdoz6Usc2PKiqexO_C5hT0EHm4G85lNGn-dpHeHzg&s=10';
  return { notification, data: payload };
}

async function sendToDevices(entries, title, body, data) {
  const messaging = getMessaging();
  if (!messaging) return { sent: 0, failed: 0, error: 'Messaging not available (Firebase not configured).' };

  const tokenList = (entries || []).map((t) => t.token).filter(Boolean);
  if (tokenList.length === 0) return { sent: 0, failed: 0, error: 'No devices have enabled notifications yet.' };

  const { notification, data: payload } = buildNotification(title, body, data);

  let sent = 0, failed = 0, invalidTokens = [];
  for (let i = 0; i < tokenList.length; i += 500) {
    const batch = tokenList.slice(i, i + 500).map((token) => ({ token, notification, data: payload }));
    try {
      const result = await messaging.sendEach(batch);
      sent += result.successCount;
      failed += result.failureCount;
      result.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error && resp.error.code;
          if (code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token' ||
              code === 'messaging/invalid-argument') {
            invalidTokens.push(batch[idx].token);
          }
        }
      });
    } catch (e) {
      failed += batch.length;
    }
  }

  if (invalidTokens.length) await removeInvalidTokens(invalidTokens);

  return { sent, failed };
}

async function sendToAllDevices(title, body, data, excludeName) {
  const tokens = await getAllTokens();
  const filtered = excludeName ? tokens.filter((t) => String(t.name) !== String(excludeName)) : tokens;
  return sendToDevices(filtered, title, body, data);
}

async function sendToNamedDevices(name, title, body, data) {
  const tokens = await getAllTokens();
  const filtered = tokens.filter((t) => String(t.name).toLowerCase() === String(name).toLowerCase());
  return sendToDevices(filtered, title, body, data);
}

/* Fire-and-forget broadcast when media is added (used server-side on uploads) */
function sendUploadNotification(type, title, uploader) {
  const kind = type === 'movie' ? 'Movie' : 'Song';
  sendToAllDevices(
    'New ' + kind + ' added!',
    String(title || 'Check it out') + ' — by ' + String(uploader || 'Anonymous'),
    { url: type === 'movie' ? '/?page=movies' : '/?page=library', type: String(type || 'song') },
    uploader
  ).catch(() => { /* non-blocking */ });
}

app.post('/api/notify/register', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const name = String(req.body.name || 'Guest').trim();
  if (!token) return res.status(400).json({ success: false, error: 'Missing token.' });
  try {
    await saveToken(token, name);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || 'Failed to register.' });
  }
});

app.post('/api/notify/unregister', async (req, res) => {
  const token = String(req.body.token || '').trim();
  try {
    await removeToken(token);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || 'Failed to unregister.' });
  }
});

/* Broadcast an announcement (admin / website updates) */
app.post('/api/notify/announce', async (req, res) => {
  const { title, body, adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!title && !body) return res.status(400).json({ success: false, error: 'Title or body required.' });
  const result = await sendToAllDevices(title || 'Announcement', body || '', { url: '/' });
  res.json({ success: true, ...result });
});

/* A new song/movie/link was uploaded -> notify everyone except the uploader */
app.post('/api/notify/upload', async (req, res) => {
  const { type, title, uploader } = req.body;
  const kind = type === 'movie' ? 'Movie' : (type === 'link' ? 'Link' : 'Song');
  const result = await sendToAllDevices(
    'New ' + kind + ' added!',
    String(title || 'Check it out') + ' — by ' + String(uploader || 'Anonymous'),
    { url: type === 'movie' ? '/?page=movies' : (type === 'link' ? '/?page=links' : '/?page=library'), type: String(type || 'song') },
    uploader
  );
  res.json({ success: true, ...result });
});

/* New chat message -> notify all chat participants except the sender */
app.post('/api/notify/chat', async (req, res) => {
  const user = String(req.body.user || 'Someone').trim();
  const text = String(req.body.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ success: false, error: 'Missing message text.' });

  const result = await sendToAllDevices(
    '@' + user + ' messaged in chat',
    text,
    { url: '/?page=chat', type: 'chat' },
    user
  );
  res.json({ success: true, sent: result.sent, failed: result.failed });
});

/* Contact/form message -> notify admin/boss person only */
app.post('/api/notify/contact', async (req, res) => {
  const user = String(req.body.user || 'Someone').trim();
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ success: false, error: 'Missing message text.' });

  const result = await sendToNamedDevices('azim', '📩 Contact message from ' + user, text, { url: '/?page=admin', type: 'contact' });
  res.json({ success: true, sent: result.sent, failed: result.failed });
});

/* Public upload notification (used by client as a reliable broadcast) */
app.post('/api/notify/send', async (req, res) => {
  const { title, body, adminSecret, data, public: isPublic } = req.body;
  const authorized = isPublic === true || adminSecret === ADMIN_SECRET;
  if (!authorized) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!title && !body) return res.status(400).json({ success: false, error: 'Title or body required.' });
  const result = await sendToAllDevices(title || 'Notification', body || '', data || {});
  res.json({ success: true, ...result });
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
