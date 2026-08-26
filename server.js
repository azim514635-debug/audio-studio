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

// Multiple Audio Upload
app.post('/api/upload', upload.array('audio', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files received' });
    }

    const uploadedTracks = [];
    const baseTitle = req.body.title || 'Untitled Track';

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const result = await cloudinary.uploader.upload(file.path, { resource_type: 'auto' });
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

      // If uploading multiple, append number tag if more than one file
      const trackTitle = req.files.length > 1 ? `${baseTitle} (${i + 1})` : baseTitle;

      const newTrack = {
        id: Date.now().toString() + i,
        title: trackTitle,
        uploadedBy: req.body.uploadedBy || 'Anonymous',
        audioUrl: result.secure_url
      };

      globalTracks.push(newTrack);
      uploadedTracks.push(newTrack);
    }

    res.json({ success: true, tracks: uploadedTracks });
  } catch (err) {
    if (req.files) {
      req.files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Multiple Movie Upload
app.post('/api/upload-movie', upload.array('movie', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files received' });
    }

    const uploadedMovies = [];
    const baseTitle = req.body.title || 'Untitled Movie';

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const result = await cloudinary.uploader.upload(file.path, { resource_type: 'video', chunk_size: 6000000 });
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

      const movieTitle = req.files.length > 1 ? `${baseTitle} (${i + 1})` : baseTitle;

      const newMovie = {
        id: Date.now().toString() + i,
        title: movieTitle,
        uploadedBy: req.body.uploadedBy || 'Anonymous',
        movieUrl: result.secure_url
      };

      globalMovies.push(newMovie);
      uploadedMovies.push(newMovie);
    }

    res.json({ success: true, movies: uploadedMovies });
  } catch (err) {
    if (req.files) {
      req.files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/media/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (type === 'track') globalTracks = globalTracks.filter(t => t.id !== id);
  else if (type === 'movie') globalMovies = globalMovies.filter(m => m.id !== id);
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
