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

// Upload Song
app.post('/api/upload/song', upload.fields([{ name: 'thumbnail' }, { name: 'audioFile' }]), async (req, res) => {
  try {
    const { title, uploader } = req.body;
    let thumbnailUrl = '';
    let songUrl = '';

    if (req.files['thumbnail']) {
      const resImg = await uploadToCloudinary(req.files['thumbnail'][0].buffer);
      thumbnailUrl = resImg.secure_url;
    }
    if (req.files['audioFile']) {
      const resAudio = await uploadToCloudinary(req.files['audioFile'][0].buffer);
      songUrl = resAudio.secure_url;
    }

    songs.push({
      id: Date.now().toString(),
      title,
      uploader: uploader || 'Anonymous',
      thumbnailUrl,
      songUrl
    });
    res.redirect('/');
  } catch (err) {
    res.status(500).send("Upload failed: " + err.message);
  }
});

// Upload Movie
app.post('/api/upload/movie', upload.fields([{ name: 'thumbnail' }, { name: 'movieFile' }]), async (req, res) => {
  try {
    const { title, uploader } = req.body;
    let thumbnailUrl = '';
    let movieUrl = '';

    if (req.files['thumbnail']) {
      const resImg = await uploadToCloudinary(req.files['thumbnail'][0].buffer);
      thumbnailUrl = resImg.secure_url;
    }
    if (req.files['movieFile']) {
      const resVideo = await uploadToCloudinary(req.files['movieFile'][0].buffer);
      movieUrl = resVideo.secure_url;
    }

    movies.push({
      id: Date.now().toString(),
      title,
      uploader: uploader || 'Anonymous',
      thumbnailUrl,
      movieUrl
    });
    res.redirect('/');
  } catch (err) {
    res.status(500).send("Upload failed: " + err.message);
  }
});

// Delete file (Admin or Owner)
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

// Rename file (Admin or Owner)
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
