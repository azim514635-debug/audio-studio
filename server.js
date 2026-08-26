const express = require('express');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

const app = express();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "your_cloud_name",
  api_key: process.env.CLOUDINARY_API_KEY || "your_api_key",
  api_secret: process.env.CLOUDINARY_API_SECRET || "your_api_secret"
});

const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let songs = [];
let movies = [];

const ADMIN_SECRET = process.env.ADMIN_SECRET || "mypassword123";

const uploadToCloudinary = (fileBuffer) => {
  return new Promise((resolve, reject) => {
    let stream = cloudinary.uploader.upload_stream(
      { resource_type: "auto" },
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      }
    );
    streamifier.createReadStream(fileBuffer).pipe(stream);
  });
};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/data', (req, res) => {
  res.json({ songs, movies });
});

// Verify Admin Password Route
app.post('/api/verify-admin', (req, res) => {
  const { adminSecret } = req.body;
  if (adminSecret === ADMIN_SECRET) {
    res.json({ success: true });
  } else {
    res.status(403).json({ success: false });
  }
});

// Upload Song (File)
app.post('/api/upload/song', upload.single('mediaFile'), async (req, res) => {
  try {
    const { title, uploader } = req.body;
    let songUrl = '';

    if (req.file) {
      const resAudio = await uploadToCloudinary(req.file.buffer);
      songUrl = resAudio.secure_url;
    }

    songs.push({
      id: Date.now().toString(),
      title,
      uploader: uploader || 'Anonymous',
      songUrl,
      thumbnailUrl: ''
    });
    res.send("Success");
  } catch (err) {
    res.status(500).send("Upload failed: " + err.message);
  }
});

// Upload Movie (File)
app.post('/api/upload/movie', upload.single('mediaFile'), async (req, res) => {
  try {
    const { title, uploader } = req.body;
    let movieUrl = '';

    if (req.file) {
      const resVideo = await uploadToCloudinary(req.file.buffer);
      movieUrl = resVideo.secure_url;
    }

    movies.push({
      id: Date.now().toString(),
      title,
      uploader: uploader || 'Anonymous',
      movieUrl,
      thumbnailUrl: ''
    });
    res.send("Success");
  } catch (err) {
    res.status(500).send("Upload failed: " + err.message);
  }
});

// Upload Link (Admin only)
app.post('/api/upload/link', (req, res) => {
  const { type, title, mediaUrl, thumbnailUrl, adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(403).send("Unauthorized");

  const newItem = {
    id: Date.now().toString(),
    title,
    uploader: 'Admin',
    thumbnailUrl: thumbnailUrl || ''
  };

  if (type === 'song') {
    newItem.songUrl = mediaUrl;
    songs.push(newItem);
  } else {
    newItem.movieUrl = mediaUrl;
    movies.push(newItem);
  }
  res.send("Success");
});

// Delete file
app.post('/api/delete', (req, res) => {
  const { type, id, uploader, adminSecret } = req.body;
  const isAdmin = adminSecret === ADMIN_SECRET;

  const list = type === 'song' ? songs : movies;
  const index = list.findIndex(item => item.id === id);

  if (index === -1) return res.status(404).send("Not found");

  if (isAdmin || list[index].uploader === uploader) {
    list.splice(index, 1);
    return res.send("Success");
  }
  res.status(403).send("Unauthorized");
});

// Rename file
app.post('/api/rename', (req, res) => {
  const { type, id, newTitle, uploader, adminSecret } = req.body;
  const isAdmin = adminSecret === ADMIN_SECRET;

  const list = type === 'song' ? songs : movies;
  const item = list.find(i => i.id === id);

  if (!item) return res.status(404).send("Not found");

  if (isAdmin || item.uploader === uploader) {
    item.title = newTitle;
    return res.send("Success");
  }
  res.status(403).send("Unauthorized");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
