window.onload = loadSongs;

const audioExtensions = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.opus', '.wma'];

function getFormattedTitle(fileName) {
  let formatted = fileName;
  const hasAudioExtension = audioExtensions.some(ext => formatted.toLowerCase().endsWith(ext));
  if (!hasAudioExtension) {
    formatted += '.mp3';
  }
  return formatted;
}

function previewFileName() {
  const fileInput = document.getElementById('songInput');
  const preview = document.getElementById('selectedFileName');
  
  if (fileInput.files.length > 0) {
    const originalName = fileInput.files[0].name;
    const finalName = getFormattedTitle(originalName);
    preview.textContent = 'Selected: ' + finalName;
  } else {
    preview.textContent = '';
  }
}

async function loadSongs() {
  const playlist = document.getElementById('playlist');
  try {
    const res = await fetch('/api/songs');
    const songs = await res.json();
    playlist.innerHTML = '';
    songs.forEach(song => renderTrack(song));
  } catch (err) {
    console.error('Failed to load songs:', err);
  }
}

async function uploadSong(e) {
  if (e) e.preventDefault();

  const fileInput = document.getElementById('songInput');
  const status = document.getElementById('statusMessage');
  const file = fileInput.files[0];

  if (!file) {
    status.textContent = 'Please select a file first.';
    return;
  }

  const formattedTitle = getFormattedTitle(file.name);
  status.textContent = 'Reading file buffer...';

  try {
    // Read raw array buffer to guarantee cross-app storage permission
    const buffer = await file.arrayBuffer();
    status.textContent = 'Uploading audio...';

    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(formattedTitle)
      },
      body: buffer
    });

    const data = await res.json();

    if (res.ok && data.success) {
      status.textContent = 'Upload successful!';
      renderTrack(data.song);
      fileInput.value = '';
      document.getElementById('selectedFileName').textContent = '';
    } else {
      status.textContent = 'Upload failed: ' + (data.message || 'Server error');
    }
  } catch (err) {
    status.textContent = 'Upload error: ' + (err.message || 'Connection failed');
    console.error('Upload Error:', err);
  }
}

function renderTrack(song) {
  const playlist = document.getElementById('playlist');
  const trackCard = document.createElement('div');
  trackCard.className = 'track-card';
  trackCard.innerHTML = `<p><b>${song.title}</b></p><audio controls src="${song.url}"></audio>`;
  playlist.prepend(trackCard);
}
