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
      } else {
        alert('Incorrect Password!');
        return;
      }
    }

    navItems.forEach(i => i.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));

    item.classList.add('active');
    document.getElementById(`page-${targetPage}`).classList.add('active');

    if (targetPage === 'admin') loadRequests();
    if (targetPage === 'library') fetchGlobalTracks();
    if (targetPage === 'movies') fetchGlobalMovies();
  });
});

// Audio Upload Logic
const uploadForm = document.getElementById('upload-form');
const songTitleInput = document.getElementById('song-title-input');
const audioFileInput = document.getElementById('audio-file');
const uploadStatus = document.getElementById('upload-status');

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const uploaderName = localStorage.getItem('visitorName');
  if (!uploaderName) {
    modalOverlay.classList.remove('hidden');
    return;
  }

  const file = audioFileInput.files[0];
  const songTitle = songTitleInput.value.trim();

  if (!file) return alert('Please select an audio file.');

  uploadStatus.textContent = 'Uploading track to server...';

  const formData = new FormData();
  formData.append('audio', file);
  formData.append('title', songTitle);
  formData.append('uploadedBy', uploaderName);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (data.success) {
      uploadStatus.textContent = 'Upload successful!';
      songTitleInput.value = '';
      audioFileInput.value = '';
      fetchGlobalTracks();
    } else {
      uploadStatus.textContent = `Upload failed: ${data.error}`;
    }
  } catch (err) {
    uploadStatus.textContent = `Network error: ${err.message}`;
  }
});

// Movie Upload Logic
const movieUploadForm = document.getElementById('movie-upload-form');
const movieTitleInput = document.getElementById('movie-title-input');
const movieFileInput = document.getElementById('movie-file');
const movieUploadStatus = document.getElementById('movie-upload-status');

movieUploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const uploaderName = localStorage.getItem('visitorName');
  if (!uploaderName) {
    modalOverlay.classList.remove('hidden');
    return;
  }

  const file = movieFileInput.files[0];
  const movieTitle = movieTitleInput.value.trim();

  if (!file) return alert('Please select a movie file.');

  movieUploadStatus.textContent = 'Uploading movie (larger files take time)...';

  const formData = new FormData();
  formData.append('movie', file);
  formData.append('title', movieTitle);
  formData.append('uploadedBy', uploaderName);

  try {
    const res = await fetch('/api/upload-movie', { method: 'POST', body: formData });
    const data = await res.json();

    if (data.success) {
      movieUploadStatus.textContent = 'Movie upload successful!';
      movieTitleInput.value = '';
      movieFileInput.value = '';
      fetchGlobalMovies();
    } else {
      movieUploadStatus.textContent = `Upload failed: ${data.error}`;
    }
  } catch (err) {
    movieUploadStatus.textContent = `Network error: ${err.message}`;
  }
});

// Fetch Tracks
async function fetchGlobalTracks() {
  const trackList = document.getElementById('track-list');
  try {
    const res = await fetch('/api/tracks');
    const tracks = await res.json();

    if (tracks.length === 0) {
      trackList.innerHTML = '<li style="color:#94a3b8;">No songs uploaded yet.</li>';
      return;
    }

    trackList.innerHTML = tracks.map(track => `
      <li style="display: flex; flex-direction: column; gap: 8px; padding: 14px; background: rgba(255,255,255,0.05); border-radius: 8px; margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 1.1rem; color: #fff;">${track.title}</strong>
          <span style="font-size: 0.8rem; color: #818cf8;">Uploaded by ${track.uploadedBy}</span>
        </div>
        <audio controls src="${track.audioUrl}" style="width: 100%; margin-top: 6px;"></audio>
      </li>
    `).join('');
  } catch (err) {
    trackList.innerHTML = '<li style="color:#ef4444;">Failed to load songs.</li>';
  }
}

// Fetch Movies
async function fetchGlobalMovies() {
  const movieList = document.getElementById('movie-list');
  try {
    const res = await fetch('/api/movies');
    const movies = await res.json();

    if (movies.length === 0) {
      movieList.innerHTML = '<li style="color:#94a3b8;">No movies uploaded yet.</li>';
      return;
    }

    movieList.innerHTML = movies.map(movie => `
      <li style="display: flex; flex-direction: column; gap: 8px; padding: 14px; background: rgba(255,255,255,0.05); border-radius: 8px; margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 1.1rem; color: #fff;">${movie.title}</strong>
          <span style="font-size: 0.8rem; color: #38bdf8;">Uploaded by ${movie.uploadedBy}</span>
        </div>
        <video controls src="${movie.movieUrl}" style="width: 100%; max-height: 300px; border-radius: 6px; margin-top: 6px;"></video>
      </li>
    `).join('');
  } catch (err) {
    movieList.innerHTML = '<li style="color:#ef4444;">Failed to load movies.</li>';
  }
}

// Requests Logic
const sendRequestBtn = document.getElementById('send-request-btn');
const requestText = document.getElementById('request-text');

sendRequestBtn.addEventListener('click', () => {
  const currentUser = localStorage.getItem('visitorName');
  if (!currentUser) {
    modalOverlay.classList.remove('hidden');
    return;
  }

  const message = requestText.value.trim();
  if (!message) return alert('Please write a request first!');

  const requests = JSON.parse(localStorage.getItem('azim_user_requests') || '[]');
  requests.push({ user: currentUser, text: message, date: new Date().toLocaleString() });

  localStorage.setItem('azim_user_requests', JSON.stringify(requests));
  alert('Your request has been sent to Azim!');
  requestText.value = '';
});

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
