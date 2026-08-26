const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');
let isAdminUnlocked = false;

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const targetPage = item.getAttribute('data-page');

    if (targetPage === 'admin' && !isAdminUnlocked) {
      const password = prompt('Enter Admin Password:');
      if (password === 'azim-website') {
        isAdminUnlocked = true;
        alert('Access Granted! Welcome Azim.');
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
  });
});

// User Profile
const usernameInput = document.getElementById('username-input');
const saveNameBtn = document.getElementById('save-name-btn');
const welcomeHeading = document.getElementById('welcome-heading');
const userDisplay = document.getElementById('user-display');

const savedUser = localStorage.getItem('visitorName');
if (savedUser) {
  welcomeHeading.textContent = `Welcome back, ${savedUser}!`;
  userDisplay.textContent = `👤 ${savedUser}`;
}

saveNameBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (name) {
    localStorage.setItem('visitorName', name);
    welcomeHeading.textContent = `Welcome, ${name}!`;
    userDisplay.textContent = `👤 ${name}`;
    usernameInput.value = '';
    alert('Name saved successfully!');
  }
});

// Upload Track to Global Server
const uploadForm = document.getElementById('upload-form');
const songTitleInput = document.getElementById('song-title-input');
const audioFileInput = document.getElementById('audio-file');
const uploadStatus = document.getElementById('upload-status');

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = audioFileInput.files[0];
  const songTitle = songTitleInput.value.trim();
  const uploaderName = localStorage.getItem('visitorName') || 'Anonymous';

  if (!file || !songTitle) return alert('Please enter a song name and select a file.');

  uploadStatus.textContent = 'Uploading track to server...';

  const formData = new FormData();
  formData.append('audio', file);
  formData.append('title', songTitle);
  formData.append('uploadedBy', uploaderName);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      uploadStatus.textContent = 'Upload successful!';
      songTitleInput.value = '';
      audioFileInput.value = '';
      fetchGlobalTracks();
    } else {
      uploadStatus.textContent = 'Upload failed.';
    }
  } catch (err) {
    uploadStatus.textContent = 'Error uploading track.';
  }
});

// Fetch Global Tracks
async function fetchGlobalTracks() {
  const trackList = document.getElementById('track-list');
  try {
    const res = await fetch('/api/tracks');
    const tracks = await res.json();

    if (tracks.length === 0) {
      trackList.innerHTML = '<li style="color:#94a3b8;">No tracks uploaded yet.</li>';
      return;
    }

    trackList.innerHTML = tracks.map(track => `
      <li style="display: flex; flex-direction: column; gap: 8px; padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px; margin-bottom: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="font-size: 1.1rem; color: #fff;">${track.title}</strong>
          <span style="font-size: 0.8rem; color: #818cf8;">Uploaded by ${track.uploadedBy}</span>
        </div>
        <audio controls src="${track.audioUrl}" style="width: 100%; margin-top: 6px;"></audio>
      </li>
    `).join('');
  } catch (err) {
    trackList.innerHTML = '<li style="color:#ef4444;">Failed to load tracks.</li>';
  }
}

// Admin Request System
const sendRequestBtn = document.getElementById('send-request-btn');
const requestText = document.getElementById('request-text');

sendRequestBtn.addEventListener('click', () => {
  const message = requestText.value.trim();
  const currentUser = localStorage.getItem('visitorName') || 'Anonymous Visitor';

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

// Load tracks on initial visit
fetchGlobalTracks();
