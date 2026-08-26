const express = require('express');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

let globalTracks = [];

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(express.json());
app.use(express.static('public'));

app.get('/api/tracks', (req, res) => {
  res.json(globalTracks);
});

app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No audio file received' });
    }

    // Upload using 'auto' resource type to properly handle .m4a, .mp3, etc.
    const result = await cloudinary.uploader.upload(req.file.path, {
      resource_type: 'auto'
    });

    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    const newTrack = {
      title: req.body.title || 'Untitled Track',
      uploadedBy: req.body.uploadedBy || 'Anonymous',
      audioUrl: result.secure_url
    };

    globalTracks.push(newTrack);
    res.json({ success: true, track: newTrack });
  } catch (err) {
    console.error('CLOUDINARY UPLOAD ERROR:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
