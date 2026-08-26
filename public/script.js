const modalOverlay = document.getElementById('name-modal');
const modalNameInput = document.getElementById('modal-name-input');
const modalSaveBtn = document.getElementById('modal-save-btn');
const userDisplay = document.getElementById('user-display');
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');

let isAdminUnlocked = false;

function checkUserSession() {
  const savedName = localStorage.getItem('visitorName');
  if (savedName) {
    modalOverlay.classList.add('hidden');
    userDisplay.textContent = `👤 ${savedName}`;
  } else {
    modalOverlay.classList.remove('hidden');
    userDisplay.textContent = 'Guest';
  }
}

modalSaveBtn.addEventListener('click', () => {
  const name = modalNameInput.value.trim();
  if (!name) return alert('Please enter your name to proceed.');
  localStorage.setItem('visitorName', name);
  userDisplay.textContent = `👤 ${name}`;
  modalOverlay.classList.add('hidden');
});

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const targetPage = item.getAttribute('data-page');
    const savedName = localStorage.getItem('visitorName');

    if ((targetPage === 'upload' || targetPage === 'movie-upload' || targetPage === 'request') && !savedName) {
      modalOverlay.classList.remove('hidden');
      return;
    }

    if (targetPage === 'admin' && !isAdminUnlocked) {
      const password = prompt('Enter Admin Password:');
      if (password === 'azim-website') {
        isAdminUnlocked = true;
        alert('Admin unlocked! You can now manage files directly from the library pages too.');
      } else {
        alert('Incorrect Password!');
        return;
      }
    }

    navItems.forEach(i => i.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));

    item.classList.add('active');
    document.getElementById(`page-${targetPage}`).classList.add('active');

    if (targetPage === 'admin') loadAdminDashboard();
    if (targetPage === 'library') fetchGlobalTracks();
    if (targetPage === 'movies') fetchGlobalMovies();
  });
});

// Multiple Audio Upload Handler
const uploadForm = document.getElementById('upload-form');
uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const uploaderName = localStorage.getItem('visitorName');
  if (!uploaderName) return modalOverlay.classList.remove('hidden');

  const files = document.getElementById('audio-file').files;
  const title = document.getElementById('song-title-input').value.trim();
  const status = document.getElementById('upload-status');

  if (files.length === 0) return alert('Please select audio files.');

  status.textContent = `Uploading ${files.length} track(s)... Please wait.`;
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('audio', files[i]);
  }
  formData.append('title', title);
  formData.append('uploadedBy', uploaderName);

  const res = await fetch('/api/upload', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.success) {
    status.textContent = `Successfully uploaded ${data.tracks.length} track(s)!`;
    uploadForm.reset();
    fetchGlobalTracks();
  } else {
    status.textContent = 'Upload failed.';
  }
});

// Multiple Movie Upload Handler
const movieUploadForm = document.getElementById('movie-upload-form');
movieUploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const uploaderName = localStorage.getItem('visitorName');
  if (!uploaderName) return modalOverlay.classList.remove('hidden');

  const files = document.getElementById('movie-file').files;
  const title = document.getElementById('movie-title-input').value.trim();
  const status = document.getElementById('movie-upload-status');

  if (files.length === 0) return alert('Please select movie files.');

  status.textContent = `Uploading ${files.length} movie(s)... Large files take time.`;
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('movie', files[i]);
  }
  formData.append('title', title);
  formData.append('uploadedBy', uploaderName);

  const res = await fetch('/api/upload-movie', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.success) {
    status.textContent = `Successfully uploaded ${data.movies.length} movie(s)!`;
    movieUploadForm.reset();
    fetchGlobalMovies();
  } else {
    status.textContent = 'Upload failed.';
  }
});

async function fetchGlobalTracks() {
  const trackList = document.getElementById('track-list');
  const res = await fetch('/api/tracks');
  const tracks = await res.json();
  if (tracks.length === 0) {
    trackList.innerHTML = '<li style="color:#94a3b8;">No songs uploaded yet.</li>';
    return;
  }
  trackList.innerHTML = tracks.map(t => `
    <li style="display: flex; flex-direction: column; gap: 8px; padding: 14px; background: rgba(255,255,255,0.05); border-radius: 8px; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong style="color: #fff;">🎵 ${t.title} <span style="font-size:0.8rem; color:#94a3b8; font-weight:normal;">(By: ${t.uploadedBy})</span></strong>
        ${isAdminUnlocked ? `
          <div style="display:flex; gap:6px;">
            <button onclick="viewInfo('Song', '${t.title}', '${t.uploadedBy}')" class="btn-primary" style="padding:4px 8px; font-size:0.75rem; background:#0ea5e9;">Info</button>
            <button onclick="renameItem('track', '${t.id}', '${t.title}')" class="btn-primary" style="padding:4px 8px; font-size:0.75rem;">Rename</button>
            <button onclick="deleteItem('track', '${t.id}')" class="btn-danger" style="padding:4px 8px; font-size:0.75rem;">Delete</button>
          </div>
        ` : ''}
      </div>
      <audio controls src="${t.audioUrl}" style="width: 100%;"></audio>
    </li>`).join('');
}

async function fetchGlobalMovies() {
  const movieList = document.getElementById('movie-list');
  const res = await fetch('/api/movies');
  const movies = await res.json();
  if (movies.length === 0) {
    movieList.innerHTML = '<li style="color:#94a3b8;">No movies uploaded yet.</li>';
    return;
  }
  movieList.innerHTML = movies.map(m => `
    <li style="display: flex; flex-direction: column; gap: 8px; padding: 14px; background: rgba(255,255,255,0.05); border-radius: 8px; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong style="color: #fff;">🎬 ${m.title} <span style="font-size:0.8rem; color:#94a3b8; font-weight:normal;">(By: ${m.uploadedBy})</span></strong>
        ${isAdminUnlocked ? `
          <div style="display:flex; gap:6px;">
            <button onclick="viewInfo('Movie', '${m.title}', '${m.uploadedBy}')" class="btn-primary" style="padding:4px 8px; font-size:0.75rem; background:#0ea5e9;">Info</button>
            <button onclick="renameItem('movie', '${m.id}', '${m.title}')" class="btn-primary" style="padding:4px 8px; font-size:0.75rem;">Rename</button>
            <button onclick="deleteItem('movie', '${m.id}')" class="btn-danger" style="padding:4px 8px; font-size:0.75rem;">Delete</button>
          </div>
        ` : ''}
      </div>
      <video controls src="${m.movieUrl}" style="width: 100%; max-height: 250px; border-radius: 6px;"></video>
    </li>`).join('');
}

async function loadAdminDashboard() {
  loadRequests();
  const box = document.getElementById('admin-media-box');
  
  const [tracksRes, moviesRes] = await Promise.all([fetch('/api/tracks'), fetch('/api/movies')]);
  const tracks = await tracksRes.json();
  const movies = await moviesRes.json();

  let html = '<h4>Songs</h4>';
  if (tracks.length === 0) html += '<p style="color:#94a3b8; font-size:0.9rem;">No songs.</p>';
  tracks.forEach(t => {
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:6px; margin-bottom:6px;">
        <span style="color:#fff;">🎵 ${t.title}</span>
        <div style="display:flex; gap:6px;">
          <button onclick="viewInfo('Song', '${t.title}', '${t.uploadedBy}')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem; background:#0ea5e9;">Info</button>
          <button onclick="renameItem('track', '${t.id}', '${t.title}')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem;">Rename</button>
          <button onclick="deleteItem('track', '${t.id}')" class="btn-danger" style="padding:4px 8px; font-size:0.8rem;">Delete</button>
        </div>
      </div>`;
  });

  html += '<h4 style="margin-top:15px;">Movies</h4>';
  if (movies.length === 0) html += '<p style="color:#94a3b8; font-size:0.9rem;">No movies.</p>';
  movies.forEach(m => {
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:6px; margin-bottom:6px;">
        <span style="color:#fff;">🎬 ${m.title}</span>
        <div style="display:flex; gap:6px;">
          <button onclick="viewInfo('Movie', '${m.title}', '${m.uploadedBy}')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem; background:#0ea5e9;">Info</button>
          <button onclick="renameItem('movie', '${m.id}', '${m.title}')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem;">Rename</button>
          <button onclick="deleteItem('movie', '${m.id}')" class="btn-danger" style="padding:4px 8px; font-size:0.8rem;">Delete</button>
        </div>
      </div>`;
  });

  box.innerHTML = html;
}

window.viewInfo = function(type, title, uploader) {
  alert(`File Details:\n- Type: ${type}\n- Title: ${title}\n- Uploaded By: ${uploader}`);
};

window.deleteItem = async function(type, id) {
  if (!confirm('Are you sure you want to delete this file?')) return;
  await fetch(`/api/media/${type}/${id}`, { method: 'DELETE' });
  loadAdminDashboard();
  fetchGlobalTracks();
  fetchGlobalMovies();
};

window.renameItem = async function(type, id, oldTitle) {
  const newTitle = prompt('Enter new title:', oldTitle);
  if (!newTitle || newTitle.trim() === '') return;
  await fetch(`/api/media/${type}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newTitle: newTitle.trim() })
  });
  loadAdminDashboard();
  fetchGlobalTracks();
  fetchGlobalMovies();
};

function loadRequests() {
  const requestsBox = document.getElementById('requests-box');
  const requests = JSON.parse(localStorage.getItem('azim_user_requests') || '[]');
  if (requests.length === 0) {
    requestsBox.innerHTML = '<p style="color:#94a3b8;">No pending requests found.</p>';
    return;
  }
  requestsBox.innerHTML = requests.map(req => `
    <div class="request-item">
      <strong>${req.user}:</strong> ${req.text}
      <small>${req.date}</small>
    </div>
  `).join('');
}

document.getElementById('clear-requests-btn').addEventListener('click', () => {
  if (confirm('Clear all stored requests?')) {
    localStorage.removeItem('azim_user_requests');
    loadRequests();
  }
});

checkUserSession();
fetchGlobalTracks();
fetchGlobalMovies();
