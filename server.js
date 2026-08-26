const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let songs = [];
let movies = [];
let externalLinks = [];

const ADMIN_SECRET = process.env.ADMIN_SECRET || "mypassword123";

// Serve the HTML file directly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/data', (req, res) => {
  res.json({ songs, movies, links: externalLinks });
});

app.post('/api/admin/song', (req, res) => {
  const { title, thumbnailUrl, songUrl, adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(403).send("Unauthorized");
  songs.push({ title, thumbnailUrl, songUrl });
  res.redirect('/');
});

app.post('/api/admin/movie', (req, res) => {
  const { title, thumbnailUrl, movieUrl, adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(403).send("Unauthorized");
  movies.push({ title, thumbnailUrl, movieUrl });
  res.redirect('/');
});

app.post('/api/admin/link', (req, res) => {
  const { title, thumbnailUrl, redirectUrl, adminSecret } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(403).send("Unauthorized");
  externalLinks.push({ title, thumbnailUrl, redirectUrl });
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
