const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Global tracks memory array
let globalTracks = [];

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(express.json());
app.use(express.static('public'));

// Fetch all tracks globally
app.get('/api/tracks', (req, res) => {
  res.json(globalTracks);
});

// Upload endpoint
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const result = await cloudinary.uploader.upload(req.file.path, {
      resource_type: 'video' // Audio files use video resource type in Cloudinary
    });

    // Delete local temporary file
    fs.unlinkSync(req.file.path);

    const newTrack = {
      title: req.body.title || 'Untitled Track',
      uploadedBy: req.body.uploadedBy || 'Anonymous',
      audioUrl: result.secure_url
    };

    globalTracks.push(newTrack);
    res.json({ success: true, track: newTrack });
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
