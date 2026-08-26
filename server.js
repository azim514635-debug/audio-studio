const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100mb' }));
// Support raw binary streams
app.use(express.raw({ type: '*/*', limit: '100mb' }));

const songsDatabase = [];

app.post('/api/upload', (req, res) => {
  try {
    const rawFilename = req.headers['x-file-name'] || `track_${Date.now()}.mp3`;
    let filename = decodeURIComponent(rawFilename);

    // Auto append .mp3 if no recognized audio format exists
    const audioExts = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.opus'];
    const hasExt = audioExts.some(ext => filename.toLowerCase().endsWith(ext));
    if (!hasExt) {
      filename += '.mp3';
    }

    const savedName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(uploadsDir, savedName);

    fs.writeFileSync(filePath, req.body);

    const newSong = {
      id: Date.now(),
      title: filename,
      url: `/uploads/${savedName}`
    };

    songsDatabase.push(newSong);
    console.log('Successfully saved file:', filename);
    res.json({ success: true, song: newSong });
  } catch (err) {
    console.error('Server Upload Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/songs', (req, res) => {
  res.json(songsDatabase);
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server live at http://127.0.0.1:${PORT}`);
});
