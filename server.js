const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
// firebase-admin v12+ removed the classic admin.messaging()/admin.database()
// namespaces — the modular getters must be imported explicitly.
const { getMessaging: fbGetMessaging } = require('firebase-admin/messaging');
const { getDatabase: fbGetDatabase } = require('firebase-admin/database');

const envCandidates = [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')];
const envFile = envCandidates.find((f) => fs.existsSync(f));
if (envFile) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
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
let firebaseAppRef = null;
let memoryDb = { songs: [], movies: [], links: [], messages: [] }; // fallback when not configured

function resolveServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const pathList = [process.env.FIREBASE_SERVICE_ACCOUNT_PATH, process.env.GOOGLE_APPLICATION_CREDENTIALS];
  const rootDir = path.join(__dirname, '..'); // project root fallback (e.g. when bundled into functions/)
  for (const p of pathList) {
    if (!p) continue;
    if (path.isAbsolute(p)) {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } else {
      const candidates = [path.join(__dirname, p), path.join(rootDir, p)];
      for (const abs of candidates) {
        if (fs.existsSync(abs)) return JSON.parse(fs.readFileSync(abs, 'utf8'));
      }
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
    const firebaseApp = admin.apps && admin.apps.length
      ? admin.apps[0]
      : admin.initializeApp({ credential: admin.cert(serviceAccount), databaseURL: DB_URL });
    firebaseAppRef = firebaseApp;
    dbRef = require('firebase-admin/firestore').getFirestore(firebaseApp)
      .collection('studio').doc('data');
    useFirebase = true;
    console.log('[Firebase] Connected to Firestore (persistent cloud storage).');
    try {
      fbGetMessaging(firebaseApp);
      console.log('[Firebase] Cloud Messaging is available — push notifications enabled.');
    } catch (e) {
      console.warn('[Firebase] Cloud Messaging unavailable:', e.message);
    }
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
      notifTokens: Array.isArray(val.notifTokens) ? val.notifTokens : [],
      users: Array.isArray(val.users) ? val.users : [],
      appeals: Array.isArray(val.appeals) ? val.appeals : []
    };
  }
  return {
    songs: Array.isArray(memoryDb.songs) ? memoryDb.songs : [],
    movies: Array.isArray(memoryDb.movies) ? memoryDb.movies : [],
    links: Array.isArray(memoryDb.links) ? memoryDb.links : [],
    messages: Array.isArray(memoryDb.messages) ? memoryDb.messages : [],
    requests: Array.isArray(memoryDb.requests) ? memoryDb.requests : [],
    notifTokens: Array.isArray(memoryDb.notifTokens) ? memoryDb.notifTokens : [],
    users: Array.isArray(memoryDb.users) ? memoryDb.users : [],
    appeals: Array.isArray(memoryDb.appeals) ? memoryDb.appeals : []
  };
}

async function saveDb(data) {
  if (useFirebase) {
    await dbRef.set({ songs: data.songs || [], movies: data.movies || [], links: data.links || [], messages: data.messages || [], requests: data.requests || [], notifTokens: data.notifTokens || [], users: data.users || [], appeals: data.appeals || [] });
  } else {
    memoryDb = { songs: data.songs || [], movies: data.movies || [], links: data.links || [], messages: data.messages || [], requests: data.requests || [], notifTokens: data.notifTokens || [], users: data.users || [], appeals: data.appeals || [] };
  }
  const size = Buffer.byteLength(JSON.stringify(data) || '[]', 'utf8');
  if (size > 700 * 1024) {
    console.warn(`[DB] WARNING: stored data is now ~${(size / 1024).toFixed(0)} KB — Cloud Firestore documents are limited to 1 MiB. Consider deleting old items.`);
  }
}

/* Serializes read-modify-write cycles. Because the whole store lives in one
   Firestore doc, two concurrent get->save sequences can overwrite each
   other's changes; the lock re-reads inside the critical section. */
let dbWriteLock = Promise.resolve();
async function withDbWrite(work) {
  const prev = dbWriteLock;
  let release;
  dbWriteLock = new Promise((r) => (release = r));
  await prev;
  try {
    return await work();
  } finally {
    release();
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const BOSS_SECRET = process.env.BOSS_SECRET || process.env.ADMIN_SECRET || "azim123";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

/* Express 4 does not catch rejections from async handlers on its own:
   wrap every async route so errors produce a clean error response instead of
   leaving requests hanging / crashing the process. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isBossReq = (req) => {
  const supplied = (req.headers && req.headers['x-boss-secret']) || (req.body && req.body.bossSecret);
  return supplied === BOSS_SECRET;
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2048 * 1024 * 1024 } });

const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---- User registration / login (server-side accounts) ---- */
const crypto = require('crypto');
// Passwords are case-insensitive: "Secret" and "secret" are the same.
const passwordKey = (password) => String(password || '').toLowerCase();
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(passwordKey(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  // Try the case-insensitive key first; fall back to the original input so
  // accounts created before case-insensitive passwords still work.
  const candidates = [passwordKey(password), String(password || '')];
  for (const c of candidates) {
    const test = crypto.scryptSync(c, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(test, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}
const normalizeName = (name) => String(name || '').trim().slice(0, 40);
const findUser = (users, name) => users.find((u) => String(u.name).toLowerCase() === String(name).toLowerCase());
const AUTH_TOKENS = {}; // token -> normalized username (in-memory sessions)

const mediaList = (type, db) => {
  if (type === 'link' || type === 'links') return db.links;
  return (type === 'movie' || type === 'movies' ? db.movies : db.songs);
};
const isMediaType = (type) => type === 'song' || type === 'songs' || type === 'movie' || type === 'movies' || type === 'link' || type === 'links';

/* Media is classified from the uploaded file's extension, not the submitted
   content-type field. */
const VIDEO_EXTS = new Set(['mp4','mkv','mov','avi','webm','flv','wmv','m4v','3gp','3g2','mpg','mpeg','m2ts','mts','ts','vob','ogv','f4v','mxf','rm','rmvb','asf']);
const mediaTypeFromName = (name) => {
  const clean = String(name || '').split(/[?#]/)[0];
  const ext = clean.split('.').pop().toLowerCase();
  return VIDEO_EXTS.has(ext) ? 'movie' : 'song';
};

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
app.get('/api/data', ah(async (req, res) => {
  res.json(await getDb());
}));

app.get('/api/tracks', ah(async (req, res) => {
  res.json((await getDb()).songs);
}));

app.get('/api/movies', ah(async (req, res) => {
  res.json((await getDb()).movies);
}));

app.get('/api/links', ah(async (req, res) => {
  res.json((await getDb()).links);
}));

/* ------------------------------------------------------------------ */
/* Boss verification                                                   */
/* ------------------------------------------------------------------ */
app.post('/api/verify-boss', (req, res) => {
  const { bossSecret } = req.body;
  if (bossSecret === BOSS_SECRET) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

/* ------------------------------------------------------------------ */
/* User registration / login / account management                      */
/* ------------------------------------------------------------------ */
app.post('/api/auth/register', ah(async (req, res) => {
  const name = normalizeName(req.body.name);
  const password = String(req.body.password || '');

  if (!name) return res.status(400).json({ success: false, error: 'Please enter your name.' });
  if (name.length < 2) return res.status(400).json({ success: false, error: 'Name must be at least 2 characters.' });
  if (String(password).length < 4) return res.status(400).json({ success: false, error: 'Password must be at least 4 characters.' });

  if (name.toLowerCase() === 'azim') {
    return res.status(400).json({ success: false, error: 'Azim is the Boss — sign in with the Boss pass instead of registering a user account.' });
  }

  const db = await getDb();
  const existing = findUser(db.users, name);
  if (existing) {
    if (existing.status === 'disabled' || existing.status === 'unregistered') {
      return res.status(403).json({ success: false, code: 'disabled', error: 'Your account has been disabled by the boss. Please appeal to get it restored.' });
    }
    if (existing.status === 'permanent') {
      return res.status(403).json({ success: false, code: 'permanent', error: 'Your account has been permanently disabled by the boss.' });
    }
    return res.status(409).json({ success: false, error: 'That name is already registered. Please log in.' });
  }

  await withDbWrite(async () => {
    const d = await getDb();
    d.users = d.users || [];
    d.users.push({ name, passwordHash: hashPassword(password), createdAt: Date.now(), token: null, status: 'active', lastLogin: null });
    await saveDb(d);
  });

  const token = crypto.randomBytes(24).toString('hex');
  AUTH_TOKENS[token] = name;
  res.json({ success: true, token, name });
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const name = normalizeName(req.body.name);
  const password = String(req.body.password || '');
  if (!name || !password) return res.status(400).json({ success: false, error: 'Please enter your name and password.' });

  if (name.toLowerCase() === 'azim') {
    return res.status(400).json({ success: false, error: 'Azim is the Boss — use the Boss login with the Boss pass.' });
  }

  const db = await getDb();
  const user = findUser(db.users, name);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ success: false, error: 'Incorrect password. Please try again.' });
  }

  if (user.status === 'disabled' || user.status === 'unregistered') {
    return res.status(403).json({
      success: false,
      code: 'disabled',
      error: 'Your account has been disabled by the boss.'
    });
  }
  if (user.status === 'permanent') {
    return res.status(403).json({
      success: false,
      code: 'permanent',
      error: 'Your account has been permanently disabled by the boss.'
    });
  }

  await withDbWrite(async () => {
    const d = await getDb();
    const u = findUser(d.users, name);
    if (u) { u.lastLogin = Date.now(); await saveDb(d); }
  });

  const token = crypto.randomBytes(24).toString('hex');
  AUTH_TOKENS[token] = user.name;
  res.json({ success: true, token, name: user.name });
}));

app.post('/api/auth/logout', (req, res) => {
  const token = String(req.body.token || '');
  delete AUTH_TOKENS[token];
  res.json({ success: true });
});

/* Boss: list all registered accounts + appeals */
app.get('/api/auth/boss', ah(async (req, res) => {
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const db = await getDb();
  const users = (db.users || []).map((u) => ({
    name: u.name,
    status: u.status === 'unregistered' ? 'disabled' : (u.status || 'active'),
    createdAt: u.createdAt || null,
    lastLogin: u.lastLogin || null
  }));
  res.json({ success: true, users, appeals: (db.appeals || []) });
}));

/* Boss: disable (temporary) or permanently disable a user account.
   A permanent disable is irreversible — there is no re-enable path for it. */
app.post('/api/auth/disable', ah(async (req, res) => {
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const name = normalizeName(req.body.name);
  if (!name) return res.status(400).json({ success: false, error: 'Missing user name.' });
  const permanent = req.body.permanent === true;

  await withDbWrite(async () => {
    const d = await getDb();
    const u = findUser(d.users, name);
    if (u) {
      // Re-enabling a *temporary* disabled account clears its pending appeal.
      if (permanent) {
        u.status = 'permanent';
        d.appeals = (d.appeals || []).filter((a) => String(a.name).toLowerCase() !== String(name).toLowerCase());
      } else {
        u.status = 'disabled';
      }
      await saveDb(d);
    }
  });
  res.json({ success: true });
}));

/* Boss: clear (remove) all permanently disabled accounts from the system.
   Permanent accounts can never be re-enabled or appealed, so this removes
   them from the registered users list entirely. */
app.post('/api/auth/clear-permanent', ah(async (req, res) => {
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });

  await withDbWrite(async () => {
    const d = await getDb();
    const before = (d.users || []).length;
    d.users = (d.users || []).filter((u) => u.status !== 'permanent');
    await saveDb(d);
    res.json({ success: true, removed: before - d.users.length });
  });
}));

/* Boss: approve (re-enable) a TEMPORARILY disabled account. Permanent
   disables cannot be reversed. */
app.post('/api/auth/approve', ah(async (req, res) => {
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const name = normalizeName(req.body.name);
  if (!name) return res.status(400).json({ success: false, error: 'Missing user name.' });

  await withDbWrite(async () => {
    const d = await getDb();
    const u = findUser(d.users, name);
    if (u && u.status === 'disabled') {
      u.status = 'active';
      d.appeals = (d.appeals || []).filter((a) => String(a.name).toLowerCase() !== String(name).toLowerCase());
      await saveDb(d);
    }
  });
  res.json({ success: true });
}));

/* User: appeal after being temporarily disabled. Permanently disabled
   accounts cannot appeal. */
app.post('/api/auth/appeal', ah(async (req, res) => {
  const name = normalizeName(req.body.name);
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!name) return res.status(400).json({ success: false, error: 'Missing your name.' });
  if (!text) return res.status(400).json({ success: false, error: 'Please write a short appeal message.' });

  const db = await getDb();
  const user = findUser(db.users, name);
  if (!user) return res.status(404).json({ success: false, error: 'Account not found.' });
  if (user.status === 'permanent') {
    return res.status(403).json({ success: false, code: 'permanent', error: 'This account has been permanently disabled and cannot be appealed.' });
  }
  if (user.status !== 'disabled') {
    return res.status(400).json({ success: false, error: 'This account is not disabled.' });
  }

  await withDbWrite(async () => {
    const d = await getDb();
    d.appeals = d.appeals || [];
    const exists = d.appeals.some((a) => String(a.name).toLowerCase() === String(name).toLowerCase() && a.status === 'pending');
    if (!exists) {
      d.appeals.unshift({ id: makeId(), name, text, timestamp: Date.now(), status: 'pending' });
    }
    await saveDb(d);
  });
  res.json({ success: true });
}));

/* ------------------------------------------------------------------ */
/* Professional upload — file upload (used with XHR progress)          */
/* ------------------------------------------------------------------ */
app.post(
  '/api/upload',
  upload.fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 }
  ]),
  ah(async (req, res) => {
    const mediaFile = req.files && req.files.mediaFile && req.files.mediaFile[0];
    if (!mediaFile) return res.status(400).json({ success: false, error: 'No media file received.' });
    const type = mediaTypeFromName(mediaFile.originalname);

    const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];
    uploadToCloudinary(mediaFile, 'video', async (mediaErr, mediaUrl) => {
      if (mediaErr) return res.status(500).json({ success: false, error: 'Cloudinary upload failed: ' + mediaErr.message });

      uploadToCloudinary(thumbnailFile, 'image', async (thumbErr, thumbUrl) => {
        if (thumbErr) return res.status(500).json({ success: false, error: 'Cloudinary upload failed: ' + thumbErr.message });

        try {
          const item = await withDbWrite(async () => {
            const db = await getDb();
            const newItem = {
              id: makeId(),
              title: String(req.body.title || mediaFile.originalname || 'Untitled').trim(),
              uploader: String(req.body.uploader || 'Anonymous').trim(),
              thumbnailUrl: thumbUrl || (req.body.thumbnailUrl || ''),
              createdAt: new Date().toISOString()
            };

            if (type === 'movie') {
              newItem.movieUrl = mediaUrl;
              db.movies.unshift(newItem);
            } else {
              newItem.songUrl = mediaUrl;
              db.songs.unshift(newItem);
            }
            await saveDb(db);
            return newItem;
          });
          sendUploadNotification(type, item.title, item.uploader);
          res.json({ success: true, type, item });
        } catch (e) {
          res.status(500).json({ success: false, error: e.message || 'Failed to save.' });
        }
      });
    });
  })
);

/* Legacy single-file upload routes (kept for compatibility) */
app.post(
  '/api/upload/song',
  upload.fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 }
  ]),
  ah(async (req, res) => {
    const mediaFile = req.files && req.files.mediaFile && req.files.mediaFile[0];
    if (!mediaFile) return res.status(400).send('No file uploaded.');

    const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];
    uploadToCloudinary(mediaFile, 'video', async (mediaErr, mediaUrl) => {
      if (mediaErr) return res.status(500).send('Cloudinary upload failed: ' + mediaErr.message);

      uploadToCloudinary(thumbnailFile, 'image', async (thumbErr, thumbUrl) => {
        if (thumbErr) return res.status(500).send('Cloudinary upload failed: ' + thumbErr.message);

        try {
          await withDbWrite(async () => {
            const db = await getDb();
            const type = mediaTypeFromName(mediaFile.originalname);
            const item = {
              id: makeId(),
              title: String(req.body.title || mediaFile.originalname).trim(),
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
          });
          res.send('Media uploaded successfully!');
        } catch (e) {
          res.status(500).send(e.message || 'Failed to save.');
        }
      });
    });
  })
);

app.post(
  '/api/upload/movie',
  upload.fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 }
  ]),
  ah(async (req, res) => {
    const mediaFile = req.files && req.files.mediaFile && req.files.mediaFile[0];
    if (!mediaFile) return res.status(400).send('No file uploaded.');

    const thumbnailFile = req.files && req.files.thumbnailFile && req.files.thumbnailFile[0];
    uploadToCloudinary(mediaFile, 'video', async (mediaErr, mediaUrl) => {
      if (mediaErr) return res.status(500).send('Cloudinary upload failed: ' + mediaErr.message);

      uploadToCloudinary(thumbnailFile, 'image', async (thumbErr, thumbUrl) => {
        if (thumbErr) return res.status(500).send('Cloudinary upload failed: ' + thumbErr.message);

        try {
          await withDbWrite(async () => {
            const db = await getDb();
            const type = mediaTypeFromName(mediaFile.originalname);
            const item = {
              id: makeId(),
              title: String(req.body.title || mediaFile.originalname).trim(),
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
          });
          res.send('Media uploaded successfully!');
        } catch (e) {
          res.status(500).send(e.message || 'Failed to save.');
        }
      });
    });
  })
);

/* ------------------------------------------------------------------ */
/* Link upload — boss only, optional thumbnail file                   */
/* ------------------------------------------------------------------ */
app.post('/api/upload/link', upload.single('thumbnailFile'), ah(async (req, res) => {
  const { title, uploader, mediaUrl, thumbnailUrl } = req.body;
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!mediaUrl) return res.status(400).json({ success: false, error: 'Missing media URL.' });
  const type = mediaTypeFromName(mediaUrl);

  const item = {
    id: makeId(),
    title: String(title || 'Untitled').trim(),
    uploader: String(uploader || 'Boss').trim(),
    createdAt: new Date().toISOString()
  };

  const finish = async () => {
    try {
      await withDbWrite(async () => {
        const db = await getDb();
        if (type === 'movie' || type === 'movies') {
          item.movieUrl = mediaUrl;
          db.movies.unshift(item);
        } else {
          item.songUrl = mediaUrl;
          db.songs.unshift(item);
        }
        await saveDb(db);
      });
      res.json({ success: true, type, item });
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
}));

/* ------------------------------------------------------------------ */
/* Links library upload — title, URL, optional thumbnail (file/URL)   */
/* ------------------------------------------------------------------ */
app.post('/api/upload/link-item', upload.single('thumbnailFile'), ah(async (req, res) => {
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
      await withDbWrite(async () => {
        const db = await getDb();
        db.links.unshift(item);
        await saveDb(db);
      });
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
}));

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Signed direct-to-Cloudinary uploads (serverless-friendly)           */
/* ------------------------------------------------------------------ */
/* On serverless hosts the request body limit and lack of reliable
   multipart streaming make proxying file uploads through the server
   impractical. Instead the browser uploads the file straight to
   Cloudinary and only writes metadata via /api/upload/finalize*. */
function cloudinarySign(params) {
  const cfg = cloudinary.config();
  const timestamp = Math.round(Date.now() / 1000);
  const toSign = Object.assign({}, params, { timestamp });
  return {
    cloudName: cfg.cloud_name,
    apiKey: cfg.api_key,
    timestamp,
    folder: String(params.folder || ''),
    signature: cloudinary.utils.api_sign_request(toSign, cfg.api_secret)
  };
}

app.get('/api/upload/cloudinary-sign', (req, res) => {
  const { type } = req.query; // 'video' | 'image' | 'auto'
  const folder = String(req.query.folder || 'azim_uploads');
  const resourceType = (type && ['video', 'image', 'raw', 'auto'].includes(type)) ? type : 'auto';
  res.json(cloudinarySign({ folder: folder + '/' + resourceType, resource_type: resourceType }));
});

async function saveUploadedItem({ title, uploader, type, mediaUrl, thumbnailUrl }) {
  return withDbWrite(async () => {
    const db = await getDb();
    const newItem = {
      id: makeId(),
      title: String(title || 'Untitled').trim(),
      uploader: String(uploader || 'Anonymous').trim(),
      thumbnailUrl: thumbnailUrl || '',
      createdAt: new Date().toISOString()
    };
    if (type === 'movie' || type === 'movies') {
      newItem.movieUrl = mediaUrl;
      db.movies.unshift(newItem);
    } else {
      newItem.songUrl = mediaUrl;
      db.songs.unshift(newItem);
    }
    await saveDb(db);
    return newItem;
  });
}

app.post('/api/upload/finalize', ah(async (req, res) => {
  const { title, uploader, mediaUrl, thumbnailUrl, type } = req.body;
  if (!mediaUrl) return res.status(400).json({ success: false, error: 'Missing media URL.' });
  const mediaType = type || mediaTypeFromName(mediaUrl);
  const item = await saveUploadedItem({ title, uploader, type: mediaType, mediaUrl, thumbnailUrl });
  sendUploadNotification(mediaType, item.title, item.uploader);
  res.json({ success: true, type: mediaType, item });
}));

app.post('/api/upload/finalize-link', ah(async (req, res) => {
  const { title, uploader, mediaUrl, thumbnailUrl } = req.body;
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!mediaUrl) return res.status(400).json({ success: false, error: 'Missing media URL.' });
  const mediaType = mediaTypeFromName(mediaUrl);
  const item = await saveUploadedItem({ title, uploader, type: mediaType, mediaUrl, thumbnailUrl });
  res.json({ success: true, type: mediaType, item });
}));

app.post('/api/upload/finalize-link-item', ah(async (req, res) => {
  const { title, url, uploader, thumbnailUrl } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'Missing download URL.' });
  const item = await withDbWrite(async () => {
    const db = await getDb();
    const newItem = {
      id: makeId(),
      title: String(title || 'Untitled').trim(),
      url: String(url).trim(),
      uploader: String(uploader || 'Anonymous').trim(),
      thumbnailUrl: String(thumbnailUrl || '').trim(),
      createdAt: new Date().toISOString()
    };
    db.links.unshift(newItem);
    await saveDb(db);
    return newItem;
  });
  res.json({ success: true, type: 'link', item });
}));

/* ------------------------------------------------------------------ */
/* Media management (rename / delete)                                  */
/* ------------------------------------------------------------------ */
const canManage = (item, uploader, bossSecret) =>
  bossSecret === BOSS_SECRET || (item && item.uploader === uploader);

app.put('/api/media/:type/:id', ah(async (req, res) => {
  const { type, id } = req.params;
  if (!isMediaType(type)) return res.status(400).json({ success: false, error: 'Invalid type.' });

  const { newTitle, uploader, bossSecret } = req.body;
  const result = await withDbWrite(async () => {
    const db = await getDb();
    const list = mediaList(type, db);
    const item = list.find((i) => i.id === id);
    if (!item) return { status: 404, body: { success: false, error: 'Not found.' } };
    if (!canManage(item, uploader, bossSecret)) return { status: 403, body: { success: false, error: 'Unauthorized' } };
    item.title = String(newTitle || item.title).trim();
    await saveDb(db);
    return { status: 200, body: { success: true, item } };
  });
  res.status(result.status).json(result.body);
}));

app.delete('/api/media/:type/:id', ah(async (req, res) => {
  const { type, id } = req.params;
  if (!isMediaType(type)) return res.status(400).json({ success: false, error: 'Invalid type.' });

  const { uploader, bossSecret } = req.body || {};
  const result = await withDbWrite(async () => {
    const db = await getDb();
    const list = mediaList(type, db);
    const item = list.find((i) => i.id === id);
    if (!item) return { status: 404, body: { success: false, error: 'Not found.' } };
    if (!canManage(item, uploader, bossSecret)) return { status: 403, body: { success: false, error: 'Unauthorized' } };

    const idx = list.indexOf(item);
    list.splice(idx, 1);
    await saveDb(db);
    return { status: 200, body: { success: true, item } };
  });
  if (result.status !== 200) return res.status(result.status).json(result.body);
  if (result.body.item) await destroyCloudinaryMedia(result.body.item);
  res.json({ success: true });
}));

/* Legacy JSON rename/delete routes (kept for compatibility) */
app.post('/api/rename', ah(async (req, res) => {
  const { type, id, newTitle, uploader, bossSecret } = req.body;
  const result = await withDbWrite(async () => {
    const db = await getDb();
    const list = mediaList(type, db);
    const item = list.find((i) => i.id === id);
    if (!item) return res.sendStatus(404);
    if (!canManage(item, uploader, bossSecret)) return res.sendStatus(403);
    item.title = String(newTitle || item.title).trim();
    await saveDb(db);
    return res.sendStatus(200);
  });
  return result;
}));

app.post('/api/delete', ah(async (req, res) => {
  const { type, id, uploader, bossSecret } = req.body;
  let item = null;
  const result = await withDbWrite(async () => {
    const db = await getDb();
    const list = mediaList(type, db);
    item = list.find((i) => i.id === id);
    if (!item) return res.sendStatus(404);
    if (!canManage(item, uploader, bossSecret)) return res.sendStatus(403);
    list.splice(list.indexOf(item), 1);
    await saveDb(db);
    return res.sendStatus(200);
  });
  if (item && result.statusCode === 200) await destroyCloudinaryMedia(item);
  return result;
}));

/* ------------------------------------------------------------------ */
/* Community chat                                                      */
/* ------------------------------------------------------------------ */
app.get('/api/messages', ah(async (req, res) => {
  res.json({ messages: (await getDb()).messages });
}));

app.post('/api/messages', ah(async (req, res) => {
  const user = String(req.body.user || 'Anonymous').trim();
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'Message cannot be empty.' });
  if (text.length > 2000) return res.status(400).json({ success: false, error: 'Message is too long.' });

  const message = await withDbWrite(async () => {
    const db = await getDb();
    const newMessage = {
      id: makeId(),
      user,
      text,
      timestamp: Date.now()
    };
    db.messages.push(newMessage);
    if (db.messages.length > 500) db.messages = db.messages.slice(-500);
    await saveDb(db);
    return newMessage;
  });

  // Notify all users (except the sender) that a new chat message arrived.
  sendToAllDevices(
    '@' + user + ' messaged in chat',
    String(text).slice(0, 200),
    { url: '/?page=chat', type: 'chat' },
    user
  ).catch(() => { /* non-blocking */ });

  res.json({ success: true, message });
}));

app.post('/api/messages/clear', ah(async (req, res) => {
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });

  await withDbWrite(async () => {
    const db = await getDb();
    db.messages = [];
    await saveDb(db);
  });
  res.json({ success: true });
}));

/* ------------------------------------------------------------------ */
/* Contact requests (stored server-side, notifies the boss)            */
/* ------------------------------------------------------------------ */
app.post('/api/contact', ah(async (req, res) => {
  const user = String(req.body.user || 'Anonymous').trim();
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'Message cannot be empty.' });

  const request = await withDbWrite(async () => {
    const db = await getDb();
    db.requests = db.requests || [];
    const newRequest = { id: makeId(), user, text, createdAt: new Date().toISOString(), timestamp: Date.now() };
    db.requests.unshift(newRequest);
    if (db.requests.length > 500) db.requests = db.requests.slice(0, 500);
    await saveDb(db);
    return newRequest;
  });

  sendToNamedDevices('azim', '📩 Contact message from ' + user, text.slice(0, 200), { url: '/?page=boss', type: 'contact' })
    .catch(() => { /* ignore */ });

  res.json({ success: true, request });
}));

app.get('/api/requests', ah(async (req, res) => {
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const db = await getDb();
  res.json({ requests: db.requests || [] });
}));

app.post('/api/requests/clear', ah(async (req, res) => {
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  await withDbWrite(async () => {
    const db = await getDb();
    db.requests = [];
    await saveDb(db);
  });
  res.json({ success: true });
}));

/* ------------------------------------------------------------------ */
/* "Seen by" tracking for messages and library media                   */
/* ------------------------------------------------------------------ */
app.post('/api/seen', ah(async (req, res) => {
  const { type, id, name } = req.body;
  if (!type || !id || !name) return res.status(400).json({ success: false, error: 'Missing fields.' });

  const result = await withDbWrite(async () => {
    const db = await getDb();

    let list = null;
    if (type === 'message' || type === 'messages') list = db.messages;
    else if (type === 'song' || type === 'songs') list = db.songs;
    else if (type === 'movie' || type === 'movies') list = db.movies;
    else if (type === 'link' || type === 'links') list = db.links;
    else return { status: 400, body: { success: false, error: 'Invalid type.' } };

    const item = list.find((i) => i.id === id);
    if (!item) return { status: 404, body: { success: false, error: 'Not found.' } };

    item.seen = item.seen || [];
    const n = String(name);
    if (!item.seen.some((s) => String(s.name).toLowerCase() === n.toLowerCase())) {
      item.seen.push({ name: n, at: Date.now() });
    }
    await saveDb(db);
    return { status: 200, body: { success: true, seen: item.seen } };
  });
  res.status(result.status).json(result.body);
}));

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
  if (!useFirebase || !firebaseAppRef) return null;
  try {
    return fbGetMessaging(firebaseAppRef);
  } catch (e) {
    return null;
  }
}

/* ---- FCM device token storage (Firebase Realtime Database) ---- */
function getRtdb() {
  if (!firebaseAppRef) return null;
  try {
    return fbGetDatabase(firebaseAppRef);
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
  return withDbWrite(async () => {
    const db = await getDb();
    db.notifTokens = db.notifTokens || [];
    if (!db.notifTokens.some((t) => t.token === token)) db.notifTokens.push(entry);
    await saveDb(db);
    return true;
  });
}

async function removeToken(token) {
  const rtdb = getRtdb();
  if (rtdb) {
    try {
      await rtdb.ref('fcm_tokens/' + tokenHash(token)).remove();
      return;
    } catch (e) { /* fall through */ }
  }
  return withDbWrite(async () => {
    const db = await getDb();
    db.notifTokens = (db.notifTokens || []).filter((t) => t.token !== token);
    await saveDb(db);
  });
}

async function removeInvalidTokens(invalidTokens) {
  if (!invalidTokens || !invalidTokens.length) return;
  for (const t of invalidTokens) {
    try { await removeToken(t); } catch (e) { /* ignore */ }
  }
}

function buildNotification(title, body, data) {
  const NOTIF_PREFIX = 'From Azim\'s Space';
  const fullTitle = title ? (NOTIF_PREFIX + ' — ' + title) : NOTIF_PREFIX;
  const notification = {};
  notification.title = fullTitle;
  if (body) notification.body = body;
  const payload = {};
  if (data && typeof data === 'object') {
    for (const k of Object.keys(data)) payload[k] = String(data[k]);
  }
  payload.title = fullTitle;
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
  const kind = type === 'movie' ? 'Video' : 'Song';
  sendToAllDevices(
    'New ' + kind + ' added!',
    String(title || 'Check it out') + ' — by ' + String(uploader || 'Anonymous'),
    { url: '/?page=library', type: String(type || 'song') },
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

/* Broadcast an announcement (boss / website updates) */
app.post('/api/notify/announce', ah(async (req, res) => {
  const { title, body } = req.body;
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!title && !body) return res.status(400).json({ success: false, error: 'Title or body required.' });
  const result = await sendToAllDevices(title || 'Announcement', body || '', { url: '/' });
  res.json({ success: true, ...result });
}));

/* A new song/movie/link was uploaded -> notify everyone except the uploader */
app.post('/api/notify/upload', ah(async (req, res) => {
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const { type, title, uploader } = req.body;
  const kind = type === 'movie' ? 'Video' : (type === 'link' ? 'Link' : 'Song');
  const result = await sendToAllDevices(
    'New ' + kind + ' added!',
    String(title || 'Check it out') + ' — by ' + String(uploader || 'Anonymous'),
    { url: '/?page=library', type: String(type || 'song') },
    uploader
  );
  res.json({ success: true, ...result });
}));

/* New chat message -> notify all chat participants except the sender */
app.post('/api/notify/chat', ah(async (req, res) => {
  const user = String(req.body.user || 'Someone').trim();
  const text = String(req.body.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ success: false, error: 'Missing message text.' });

  // Only broadcast push notifications for messages that genuinely exist in
  // the chat history, so a random visitor can't spam every device.
  const db = await getDb();
  const recent = (db.messages || []).slice(-10);
  const matched = recent.some(
    (m) => String(m.user).trim() === user && String(m.text).trim().slice(0, 200) === text
  );
  if (!matched) return res.status(400).json({ success: false, error: 'No matching message to notify about.' });

  const result = await sendToAllDevices(
    '@' + user + ' messaged in chat',
    text,
    { url: '/?page=chat', type: 'chat' },
    user
  );
  res.json({ success: true, sent: result.sent, failed: result.failed });
}));

/* Contact/form message -> notify boss person only */
app.post('/api/notify/contact', ah(async (req, res) => {
  const user = String(req.body.user || 'Someone').trim();
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ success: false, error: 'Missing message text.' });

  const result = await sendToNamedDevices('azim', '📩 Contact message from ' + user, text, { url: '/?page=boss', type: 'contact' });
  res.json({ success: true, sent: result.sent, failed: result.failed });
}));

/* Upload notification broadcast — boss only (previously open to any visitor) */
app.post('/api/notify/send', ah(async (req, res) => {
  const { title, body, data } = req.body;
  if (!isBossReq(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!title && !body) return res.status(400).json({ success: false, error: 'Title or body required.' });
  const result = await sendToAllDevices(title || 'Notification', body || '', data || {});
  res.json({ success: true, ...result });
}));

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

/* Serverless hosts (Netlify/Vercel) import this module and wrap `app`;
   only bind a port when the file is run directly (node server.js). */
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;
