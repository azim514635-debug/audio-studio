const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

let globalTracks = [];
let globalMovies = [];

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(express.json());
app.use(express.static('public'));

app.get('/api/tracks', (req, res) => res.json(globalTracks));
app.get('/api/movies', (req, res) => res.json(globalMovies));

app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file' });
    const result = await cloudinary.uploader.upload(req.file.path, { resource_type: 'auto' });
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    const newTrack = {
      id: Date.now().toString(),
      title: req.body.title || 'Untitled Track',
      uploadedBy: req.body.uploadedBy || 'Anonymous',
      audioUrl: result.secure_url
    };
    globalTracks.push(newTrack);
    res.json({ success: true, track: newTrack });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/upload-movie', upload.single('movie'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file' });
    const result = await cloudinary.uploader.upload(req.file.path, { resource_type: 'video', chunk_size: 6000000 });
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    const newMovie = {
      id: Date.now().toString(),
      title: req.body.title || 'Untitled Movie',
      uploadedBy: req.body.uploadedBy || 'Anonymous',
      movieUrl: result.secure_url
    };
    globalMovies.push(newMovie);
    res.json({ success: true, movie: newMovie });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Delete and Rename Routes
app.delete('/api/media/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (type === 'track') {
    globalTracks = globalTracks.filter(t => t.id !== id);
  } else if (type === 'movie') {
    globalMovies = globalMovies.filter(m => m.id !== id);
  }
  res.json({ success: true });
});

app.put('/api/media/:type/:id', (req, res) => {
  const { type, id } = req.params;
  const { newTitle } = req.body;
  if (type === 'track') {
    const track = globalTracks.find(t => t.id === id);
    if (track) track.title = newTitle;
  } else if (type === 'movie') {
    const movie = globalMovies.find(m => m.id === id);
    if (movie) movie.title = newTitle;
  }
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
