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
let externalLinks = [];

const ADMIN_SECRET = process.env.ADMIN_SECRET || "mypassword123";

const uploadToCloudinary = (fileBuffer) => {
  return new Promise((resolve, reject) => {
    let stream = cloudinary.uploader.upload_stream(
      { resource_type: "auto" },
      (error, result) => {
        if (result) resolve(result.secure_url);
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
  res.json({ songs, movies, links: externalLinks });
});

app.post('/api/admin/song', upload.fields([{ name: 'thumbnail' }, { name: 'audioFile' }]), async (req, res) => {
  try {
    const { title, adminSecret } = req.body;
    if (adminSecret !== ADMIN_SECRET) return res.status(403).send("Unauthorized");

    let thumbnailUrl = '';
    let songUrl = '';

    if (req.files['thumbnail']) {
      thumbnailUrl = await uploadToCloudinary(req.files['thumbnail'][0].buffer);
    }
    if (req.files['audioFile']) {
      songUrl = await uploadToCloudinary(req.files['audioFile'][0].buffer);
    }

    songs.push({ title, thumbnailUrl, songUrl });
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send("Upload failed: " + err.message);
  }
});

app.post('/api/admin/movie', upload.fields([{ name: 'thumbnail' }, { name: 'movieFile' }]), async (req, res) => {
  try {
    const { title, adminSecret } = req.body;
    if (adminSecret !== ADMIN_SECRET) return res.status(403).send("Unauthorized");

    let thumbnailUrl = '';
    let movieUrl = '';

    if (req.files['thumbnail']) {
      thumbnailUrl = await uploadToCloudinary(req.files['thumbnail'][0].buffer);
    }
    if (req.files['movieFile']) {
      movieUrl = await uploadToCloudinary(req.files['movieFile'][0].buffer);
    }

    movies.push({ title, thumbnailUrl, movieUrl });
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send("Upload failed: " + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
