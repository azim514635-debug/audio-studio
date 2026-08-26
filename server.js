const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let songs = [];
let movies = [];
let externalLinks = [];

const ADMIN_SECRET = process.env.ADMIN_SECRET || "mypassword123";

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Azim's Studio Pro</title>
      <style>
        body { font-family: Arial, sans-serif; background: #0b0f19; color: #f8fafc; padding: 20px; margin: 0; }
        h1, h2 { color: #38bdf8; }
        .container { max-width: 1000px; margin: 0 auto; }
        .brand-header { font-size: 24px; font-weight: bold; color: #fff; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }
        .brand-header span { background: #6366f1; font-size: 12px; padding: 2px 8px; border-radius: 4px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .card { background: #1e293b; padding: 12px; border-radius: 8px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .card img { width: 100%; height: 200px; object-fit: cover; border-radius: 6px; }
        .card h3 { font-size: 16px; margin: 10px 0 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .card a { display: block; margin-top: 8px; background: #0284c7; color: #fff; padding: 8px; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 14px; }
        .admin-section { background: #1e293b; padding: 20px; border-radius: 8px; margin-top: 40px; border: 1px solid #334155; }
        input { display: block; width: 100%; box-sizing: border-box; margin: 8px 0 15px; padding: 10px; background: #0f172a; border: 1px solid #475569; color: #fff; border-radius: 4px; }
        button { background: #6366f1; color: white; border: none; padding: 10px 15px; cursor: pointer; border-radius: 4px; font-weight: bold; width: 100%; }
        button:hover { background: #4f46e5; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="brand-header">Azim's Studio Pro <span>PRO</span></div>

        <h2>🎵 Songs</h2>
        <div id="songs-container" class="grid"><p style="color: #94a3b8;">No songs available.</p></div>

        <h2>🎬 Movies</h2>
        <div id="movies-container" class="grid"><p style="color: #94a3b8;">No movies available.</p></div>

        <h2>📂 External Links & Downloads</h2>
        <div id="links-container" class="grid"><p style="color: #94a3b8;">No links available.</p></div>

        <div class="admin-section">
          <h3>🔒 Admin Panel (Uploads)</h3>
          
          <form action="/api/admin/song" method="POST">
            <h4>Upload Song</h4>
            <input type="text" name="title" placeholder="Enter song name..." required>
            <input type="text" name="thumbnailUrl" placeholder="Thumbnail Image URL" required>
            <input type="text" name="songUrl" placeholder="Song Stream/Audio URL" required>
            <input type="password" name="adminSecret" placeholder="Admin Password" required>
            <button type="submit">Add Song</button>
          </form>

          <hr style="border: 0; border-top: 1px solid #334155; margin: 30px 0;">

          <form action="/api/admin/movie" method="POST">
            <h4>Upload Movie</h4>
            <input type="text" name="title" placeholder="Movie Title" required>
            <input type="text" name="thumbnailUrl" placeholder="Thumbnail Image URL" required>
            <input type="text" name="movieUrl" placeholder="Movie URL" required>
            <input type="password" name="adminSecret" placeholder="Admin Password" required>
            <button type="submit">Add Movie</button>
          </form>

          <hr style="border: 0; border-top: 1px solid #334155; margin: 30px 0;">

          <form action="/api/admin/link" method="POST">
            <h4>Upload External Link (e.g., Download Link)</h4>
            <input type="text" name="title" placeholder="Link Title (e.g., Download Avengers Here)" required>
            <input type="text" name="thumbnailUrl" placeholder="Thumbnail Image URL" required>
            <input type="text" name="redirectUrl" placeholder="Destination Custom URL" required>
            <input type="password" name="adminSecret" placeholder="Admin Password" required>
            <button type="submit">Add External Link</button>
          </form>
        </div>
      </div>

      <script>
        fetch('/api/data')
          .then(res => res.json())
          .then(data => {
            const sContainer = document.getElementById('songs-container');
            if(data.songs.length > 0) {
              sContainer.innerHTML = data.songs.map(s => \`
                <div class="card">
                  <img src="\${s.thumbnailUrl}" alt="\${s.title}">
                  <h3>\${s.title}</h3>
                  <a href="\${s.songUrl}" target="_blank">Play Song</a>
                </div>
              \`).join('');
            }

            const mContainer = document.getElementById('movies-container');
            if(data.movies.length > 0) {
              mContainer.innerHTML = data.movies.map(m => \`
                <div class="card">
                  <img src="\${m.thumbnailUrl}" alt="\${m.title}">
                  <h3>\${m.title}</h3>
                  <a href="\${m.movieUrl}" target="_blank">Watch Movie</a>
                </div>
              \`).join('');
            }

            const lContainer = document.getElementById('links-container');
            if(data.links.length > 0) {
              lContainer.innerHTML = data.links.map(l => \`
                <div class="card">
                  <img src="\${l.thumbnailUrl}" alt="\${l.title}">
                  <h3>\${l.title}</h3>
                  <a href="\${l.redirectUrl}" target="_blank">Open Link</a>
                </div>
              \`).join('');
            }
          });
      </script>
    </body>
    </html>
  `);
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
app.listen(PORT, () => console.log(\`Server running on port \${PORT}\`));
