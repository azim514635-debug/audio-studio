const $ = (id) => document.getElementById(id);

const modalOverlay = $('name-modal');
const modalNameInput = $('modal-name-input');
const modalSaveBtn = $('modal-save-btn');
const avatarInitials = $('avatar-initials');
const navItems = document.querySelectorAll('.menu-link');
const pages = document.querySelectorAll('.page');

let currentUser = localStorage.getItem('visitorName') || '';
let isAdminUnlocked = false;
let adminSecret = '';
let isAdminChecking = false;
const BOSS_KEY = 'azim_boss_unlocked';
let isBossUnlocked = localStorage.getItem(BOSS_KEY) === '1';

function isBossName() {
  const n = (currentUser || '').trim().toLowerCase();
  return n === 'azim';
}

function roleLabel() {
  return isBossName() ? 'Boss' : 'Admin';
}

/* ------------------------------------------------------------------ */
/* Name / session                                                      */
/* ------------------------------------------------------------------ */
function renderAvatar() {
  const name = currentUser || 'Guest';
  let display = name.charAt(0).toUpperCase();
  if (name === 'Guest') display = '?';
  avatarInitials.textContent = display;
  avatarInitials.title = name;
}

function checkUserSession() {
  if (currentUser) {
    modalOverlay.classList.add('hidden');
  } else {
    modalOverlay.classList.remove('hidden');
  }
  renderAvatar();
}

modalSaveBtn.addEventListener('click', () => {
  const name = modalNameInput.value.trim();
  if (!name) return alert('Please enter your name to proceed.');
  currentUser = name;
  localStorage.setItem('visitorName', name);
  modalOverlay.classList.add('hidden');
  renderAvatar();
  if (isBossName() && (isBossUnlocked || isAdminUnlocked)) applyBossLabeling();
});

modalNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') modalSaveBtn.click();
});

function requireName() {
  if (!currentUser) {
    modalOverlay.classList.remove('hidden');
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Navigation + admin/boss gate (server-verified)                      */
/* ------------------------------------------------------------------ */
async function ensureBossUnlock() {
  if (isBossUnlocked || isAdminUnlocked) return true;
  if (!isBossName()) return true;

  return new Promise((resolve) => {
    const modal = $('boss-modal');
    if (!modal) { resolve(false); return; }
    const input = $('boss-modal-input');
    const errEl = $('boss-modal-error');
    const promptEl = $('boss-modal-prompt');
    errEl.style.display = 'none';
    input.value = '';
    if (promptEl) promptEl.textContent = 'You are ' + currentUser + ' — enter your pass to declare you are the Boss.';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);

    const close = () => { modal.classList.add('hidden'); removeHandlers(); resolve(false); };

    const attempt = async () => {
      const password = input.value.trim();
      if (!password) return;
      try {
        const res = await fetch('/api/verify-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adminSecret: password })
        });
        const data = await res.json();
        if (data.success) {
          isBossUnlocked = true;
          isAdminUnlocked = true;
          localStorage.setItem(BOSS_KEY, '1');
          adminSecret = password;
          const circle = $('admin-circle-btn');
          if (circle) { circle.textContent = '🔓'; circle.classList.add('unlocked'); }
          $('clear-chat-btn').style.display = 'inline-block';
          modal.classList.add('hidden');
          removeHandlers();
          applyBossLabeling();
          fetchGlobalTracks();
          fetchGlobalMovies();
          fetchGlobalLinks();
          resolve(true);
        } else {
          errEl.style.display = 'block';
        }
      } catch (e) {
        errEl.style.display = 'block';
      }
    };

    const okHandler = () => attempt();
    const cancelHandler = () => close();
    const keyHandler = (e) => {
      if (e.key === 'Enter') attempt();
      if (e.key === 'Escape') close();
    };

    function removeHandlers() {
      $('boss-modal-ok').removeEventListener('click', okHandler);
      $('boss-modal-cancel').removeEventListener('click', cancelHandler);
      modal.removeEventListener('keydown', keyHandler);
    }

    $('boss-modal-ok').addEventListener('click', okHandler);
    $('boss-modal-cancel').addEventListener('click', cancelHandler);
    modal.addEventListener('keydown', keyHandler);
  });
}

function applyBossLabeling() {
  const label = roleLabel();
  document.querySelectorAll('[data-admin-text]').forEach((el) => {
    el.textContent = el.textContent.replace(/^Admin/, label);
  });
  // Relabel visible "Admin" strings only for the boss
  const circle = $('admin-circle-btn');
  if (circle) circle.title = (isBossName() ? 'Boss' : 'Admin') + ' Panel';
  const fabLabel = document.querySelector('.admin-fab-label');
  if (fabLabel) fabLabel.textContent = (isBossName() ? 'Boss' : 'Admin') + ' Panel';
  const heading = $('boss-admin-heading');
  if (heading) heading.textContent = '🔒 ' + (isBossName() ? 'Boss' : 'Admin') + ' Dashboard';
}

async function ensureAdmin() {
  if (isAdminUnlocked || isBossUnlocked) return true;
  if (isAdminChecking) return isAdminUnlocked;
  if (isBossName()) {
    const unlocked = await ensureBossUnlock();
    if (unlocked) { isAdminUnlocked = true; applyBossLabeling(); return true; }
    return false;
  }

  return new Promise((resolve) => {
    const modal = $('admin-modal');
    const input = $('admin-modal-input');
    const errEl = $('admin-modal-error');
    errEl.style.display = 'none';
    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);

    const close = () => { modal.classList.add('hidden'); removeHandlers(); resolve(false); };

    const attempt = async () => {
      const password = input.value.trim();
      if (!password) return;
      try {
        const res = await fetch('/api/verify-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adminSecret: password })
        });
        const data = await res.json();
        if (data.success) {
          isAdminUnlocked = true;
          adminSecret = password;
          $('clear-chat-btn').style.display = 'inline-block';
          const circle = $('admin-circle-btn');
          if (circle) { circle.textContent = '🔓'; circle.classList.add('unlocked'); }
          modal.classList.add('hidden');
          removeHandlers();
          applyBossLabeling();
          fetchGlobalTracks();
          fetchGlobalMovies();
          fetchGlobalLinks();
          resolve(true);
        } else {
          errEl.style.display = 'block';
        }
      } catch (e) {
        errEl.style.display = 'block';
      }
    };

    const okHandler = () => attempt();
    const cancelHandler = () => close();
    const keyHandler = (e) => {
      if (e.key === 'Enter') attempt();
      if (e.key === 'Escape') close();
    };

    function removeHandlers() {
      $('admin-modal-ok').removeEventListener('click', okHandler);
      $('admin-modal-cancel').removeEventListener('click', cancelHandler);
      modal.removeEventListener('keydown', keyHandler);
    }

    $('admin-modal-ok').addEventListener('click', okHandler);
    $('admin-modal-cancel').addEventListener('click', cancelHandler);
    modal.addEventListener('keydown', keyHandler);
  });
}

async function showPage(targetPage) {
  pages.forEach((p) => p.classList.remove('active'));
  const match = Array.from(navItems).find((i) => i.getAttribute('data-page') === targetPage);
  navItems.forEach((i) => i.classList.remove('active'));
  if (match) match.classList.add('active');
  $('page-' + targetPage).classList.add('active');

  if (targetPage === 'admin') loadAdminDashboard();
  if (targetPage === 'library') fetchGlobalTracks();
  if (targetPage === 'movies') fetchGlobalMovies();
  if (targetPage === 'links') fetchGlobalLinks();
  if (targetPage === 'chat') { scrollChatToBottom(); }
  if (targetPage === 'notifications') initMessaging();
}

async function navigateTo(targetPage, navEl) {
  if ((targetPage === 'upload' || targetPage === 'request') && !requireName()) return;
  if (targetPage === 'chat' && !requireName()) return;

  if (targetPage === 'admin') {
    const ok = await ensureAdmin();
    if (!ok) return;
  }

  await showPage(targetPage);

  if (targetPage === 'home') {
    history.replaceState({ page: 'home' }, '', location.pathname);
  } else {
    history.pushState({ page: targetPage }, '', `?page=${targetPage}`);
  }

  closeMenu();
}

/* Browser / phone back button — return to Home instead of leaving the site */
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(location.search);
  const target = params.get('page') || 'home';
  showPage(target);
  closeMenu();
});

/* On initial load, honor an existing page param in the URL */
(function restoreInitialPage() {
  const params = new URLSearchParams(location.search);
  const target = params.get('page');
  if (target && target !== 'home' && $('page-' + target)) {
    showPage(target);
  } else {
    history.replaceState({ page: 'home' }, '', location.pathname);
  }
})();

navItems.forEach((item) => {
  item.addEventListener('click', () => navigateTo(item.getAttribute('data-page'), item));
});

document.querySelectorAll('.dash-card').forEach((card) => {
  card.addEventListener('click', () => {
    const target = card.getAttribute('data-page');
    const navMatch = Array.from(navItems).find((i) => i.getAttribute('data-page') === target);
    navigateTo(target, navMatch || null);
  });
});

function openMenu() {
  const panel = $('menu-panel');
  const toggle = $('menu-toggle');
  panel.classList.add('open');
  toggle.classList.add('open');
  toggle.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  const panel = $('menu-panel');
  const toggle = $('menu-toggle');
  panel.classList.remove('open');
  toggle.classList.remove('open');
  toggle.setAttribute('aria-expanded', 'false');
}
$('menu-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('menu-panel');
  if (panel.classList.contains('open')) closeMenu();
  else openMenu();
});
document.addEventListener('click', (e) => {
  if (!$('menu-panel').contains(e.target) && !$('menu-toggle').contains(e.target)) closeMenu();
});

$('admin-circle-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  navigateTo('admin', null);
});

document.querySelector('.brand').addEventListener('click', () => {
  navigateTo('home', null);
});

/* ------------------------------------------------------------------ */
/* HTML helpers                                                        */
/* ------------------------------------------------------------------ */
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/* ------------------------------------------------------------------ */
/* Songs / Movies libraries                                            */
/* ------------------------------------------------------------------ */
async function fetchGlobalTracks() {
  const trackList = $('track-list');
  if (!trackList) return;
  const res = await fetch('/api/tracks');
  const tracks = await res.json();

  if (!tracks || tracks.length === 0) {
    trackList.innerHTML = '<li style="color:#94a3b8;">No songs uploaded yet.</li>';
    return;
  }
  trackList.innerHTML = tracks.map((t) => `
    <li class="track-item">
      ${t.thumbnailUrl
        ? `<img class="track-thumb square" src="${escapeHtml(t.thumbnailUrl)}" alt="">`
        : `<div class="track-thumb-placeholder">🎵</div>`}
      <div class="track-body">
        <div class="track-title-row">
          <div>
            <div class="track-title">🎵 ${escapeHtml(t.title)}</div>
            <div class="track-by">By: ${escapeHtml(t.uploader)}</div>
          </div>
          ${isAdminUnlocked || isBossUnlocked ? `
            <div class="track-actions">
              <button onclick="viewInfo('Song', '${escapeHtml(t.title).replace(/'/g, "\\'")}', '${escapeHtml(t.uploader).replace(/'/g, "\\'")}')" class="btn-primary" style="background:#0ea5e9;">Info</button>
              <button onclick="renameItem('song', '${t.id}', '${escapeHtml(t.title).replace(/'/g, "\\'")}')" class="btn-primary">Rename</button>
              <button onclick="deleteItem('song', '${t.id}')" class="btn-danger">Delete</button>
            </div>` : ''}
        </div>
        ${(isAdminUnlocked || isBossUnlocked) ? seenHtml(t) : ''}
        <audio controls src="${escapeHtml(t.audioUrl || t.songUrl)}" style="width: 100%;" onplay="markSeen('song', '${t.id}')"></audio>
      </div>
    </li>`).join('');
}

async function fetchGlobalMovies() {
  const movieList = $('movie-list');
  if (!movieList) return;
  const res = await fetch('/api/movies');
  const movies = await res.json();

  if (!movies || movies.length === 0) {
    movieList.innerHTML = '<li style="color:#94a3b8;">No movies uploaded yet.</li>';
    return;
  }
  movieList.innerHTML = movies.map((m) => `
    <li class="track-item">
      ${m.thumbnailUrl
        ? `<img class="track-thumb" src="${escapeHtml(m.thumbnailUrl)}" alt="">`
        : `<div class="track-thumb-placeholder">🎬</div>`}
      <div class="track-body">
        <div class="track-title-row">
          <div>
            <div class="track-title">🎬 ${escapeHtml(m.title)}</div>
            <div class="track-by">By: ${escapeHtml(m.uploader)}</div>
          </div>
          ${isAdminUnlocked || isBossUnlocked ? `
            <div class="track-actions">
              <button onclick="viewInfo('Movie', '${escapeHtml(m.title).replace(/'/g, "\\'")}', '${escapeHtml(m.uploader).replace(/'/g, "\\'")}')" class="btn-primary" style="background:#0ea5e9;">Info</button>
              <button onclick="renameItem('movie', '${m.id}', '${escapeHtml(m.title).replace(/'/g, "\\'")}')" class="btn-primary">Rename</button>
              <button onclick="deleteItem('movie', '${m.id}')" class="btn-danger">Delete</button>
            </div>` : ''}
        </div>
        ${(isAdminUnlocked || isBossUnlocked) ? seenHtml(m) : ''}
        <video controls src="${escapeHtml(m.movieUrl)}" style="width: 100%; max-height: 280px; border-radius: 6px;" onplay="markSeen('movie', '${m.id}')"></video>
      </div>
    </li>`).join('');
}

async function fetchGlobalLinks() {
  const linkList = $('link-list');
  if (!linkList) return;
  let links = [];
  try {
    const res = await fetch('/api/links');
    links = await res.json();
  } catch (e) { /* ignore */ }

  if (!links || links.length === 0) {
    linkList.innerHTML = '<li style="color:#94a3b8;">No links yet. Add one from the Upload page.</li>';
    return;
  }
  linkList.innerHTML = links.map((l) => `
    <li class="track-item">
      ${l.thumbnailUrl
        ? `<img class="track-thumb" src="${escapeHtml(l.thumbnailUrl)}" alt="">`
        : `<div class="track-thumb-placeholder">🔗</div>`}
      <div class="track-body">
        <div class="track-title-row">
          <div>
            <div class="track-title">🔗 ${escapeHtml(l.title)}</div>
            <div class="track-by">Shared by: ${escapeHtml(l.uploader)}</div>
          </div>
          ${isAdminUnlocked || isBossUnlocked ? `
            <div class="track-actions">
              <button onclick="viewInfo('Link', '${escapeHtml(l.title).replace(/'/g, "\\'")}', '${escapeHtml(l.uploader).replace(/'/g, "\\'")}')" class="btn-primary" style="background:#0ea5e9;">Info</button>
              <button onclick="renameItem('link', '${l.id}', '${escapeHtml(l.title).replace(/'/g, "\\'")}')" class="btn-primary">Rename</button>
              <button onclick="deleteItem('link', '${l.id}')" class="btn-danger">Delete</button>
            </div>` : ''}
        </div>
        ${(isAdminUnlocked || isBossUnlocked) ? seenHtml(l) : ''}
        <a class="btn-primary download-btn" href="${escapeHtml(l.url)}" target="_blank" rel="noopener" onclick="markSeen('link', '${l.id}')">⬇ Click here to download</a>
      </div>
    </li>`).join('');
}

window.viewInfo = function (type, title, uploader) {
  alert(`File Details:\n- Type: ${type}\n- Title: ${title}\n- Uploaded By: ${uploader}`);
};

window.deleteItem = async function (type, id) {
  type = type === 'track' ? 'song' : type;
  if (!confirm('Are you sure you want to delete this file?')) return;
  const res = await fetch(`/api/media/${type}/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploader: currentUser, adminSecret })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'Delete failed.'); return; }
  loadAdminDashboard();
  fetchGlobalTracks();
  fetchGlobalMovies();
};

window.renameItem = async function (type, id, oldTitle) {
  type = type === 'track' ? 'song' : type;
  const newTitle = prompt('Enter new title:', oldTitle);
  if (!newTitle || newTitle.trim() === '') return;
  const res = await fetch(`/api/media/${type}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newTitle: newTitle.trim(), uploader: currentUser, adminSecret })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'Rename failed.'); return; }
  loadAdminDashboard();
  fetchGlobalTracks();
  fetchGlobalMovies();
};

/* ------------------------------------------------------------------ */
/* Admin dashboard + requests                                          */
/* ------------------------------------------------------------------ */
async function loadAdminDashboard() {
  loadRequests();
  const box = $('admin-media-box');

  const [tracksRes, moviesRes, linksRes] = await Promise.all([fetch('/api/tracks'), fetch('/api/movies'), fetch('/api/links')]);
  const tracks = await tracksRes.json();
  const movies = await moviesRes.json();
  const links = await linksRes.json();

  let html = '<h4>Songs</h4>';
  if (tracks.length === 0) html += '<p style="color:#94a3b8; font-size:0.9rem;">No songs.</p>';
  tracks.forEach((t) => {
    const safeTitle = escapeHtml(t.title).replace(/'/g, "\\'");
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:6px; margin-bottom:6px;">
        <span style="color:#fff;">🎵 ${escapeHtml(t.title)} <span style="font-size:0.72rem; color:#94a3b8;">— ${escapeHtml(t.uploader)}</span></span>
        <div style="display:flex; gap:6px;">
          <button onclick="viewInfo('Song', '${safeTitle}', '${escapeHtml(t.uploader).replace(/'/g, "\\'")}')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem; background:#0ea5e9;">Info</button>
          <button onclick="renameItem('song', '${t.id}', '${safeTitle}')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem;">Rename</button>
          <button onclick="deleteItem('song', '${t.id}')" class="btn-danger" style="padding:4px 8px; font-size:0.8rem;">Delete</button>
        </div>
      </div>`;
  });

  html += '<h4 style="margin-top:15px;">Movies</h4>';
  if (movies.length === 0) html += '<p style="color:#94a3b8; font-size:0.9rem;">No movies.</p>';
  movies.forEach((m) => {
    const safeTitle = escapeHtml(m.title).replace(/'/g, "\\'");
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:6px; margin-bottom:6px;">
        <span style="color:#fff;">🎬 ${escapeHtml(m.title)} <span style="font-size:0.72rem; color:#94a3b8;">— ${escapeHtml(m.uploader)}</span></span>
        <div style="display:flex; gap:6px;">
          <button onclick="viewInfo('Movie', '${safeTitle}', '${escapeHtml(m.uploader).replace(/'/g, "\\'")}')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem; background:#0ea5e9;">Info</button>
          <button onclick="renameItem('movie', '${m.id}', '${safeTitle}')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem;">Rename</button>
          <button onclick="deleteItem('movie', '${m.id}')" class="btn-danger" style="padding:4px 8px; font-size:0.8rem;">Delete</button>
        </div>
      </div>`;
  });

  html += '<h4 style="margin-top:15px;">Links</h4>';
  if (links.length === 0) html += '<p style="color:#94a3b8; font-size:0.9rem;">No links.</p>';
  links.forEach((l) => {
    const safeTitle = escapeHtml(l.title).replace(/'/g, "\\'");
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:6px; margin-bottom:6px;">
        <span style="color:#fff;">🔗 ${escapeHtml(l.title)} <span style="font-size:0.72rem; color:#94a3b8;">— ${escapeHtml(l.uploader)}</span></span>
        <div style="display:flex; gap:6px;">
          <button onclick="window.open('${escapeHtml(l.url)}','_blank')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem; background:#0ea5e9;">Open</button>
          <button onclick="renameItem('link', '${l.id}', '${safeTitle}')" class="btn-primary" style="padding:4px 8px; font-size:0.8rem;">Rename</button>
          <button onclick="deleteItem('link', '${l.id}')" class="btn-danger" style="padding:4px 8px; font-size:0.8rem;">Delete</button>
        </div>
      </div>`;
  });

  box.innerHTML = html;
}

async function loadRequests() {
  const requestsBox = $('requests-box');
  let requests = [];
  try {
    const res = await fetch('/api/requests');
    const data = await res.json();
    requests = data.requests || requests;
  } catch (e) {
    requests = JSON.parse(localStorage.getItem('azim_user_requests') || '[]');
  }
  if (requests.length === 0) {
    requestsBox.innerHTML = '<p style="color:#94a3b8;">No pending requests found.</p>';
    return;
  }
  requestsBox.innerHTML = requests.map((req) => `
    <div class="request-item">
      <strong>${escapeHtml(req.user)}:</strong> ${escapeHtml(req.text)}
      <small>${escapeHtml(req.date || new Date(Number(req.timestamp) || Date.now()).toLocaleString())}</small>
    </div>
  `).join('');
}

$('clear-requests-btn').addEventListener('click', async () => {
  if (confirm('Clear all stored requests?')) {
    localStorage.removeItem('azim_user_requests');
    try {
      await fetch('/api/requests/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminSecret })
      });
    } catch (e) { /* non-blocking */ }
    loadRequests();
  }
});

$('send-request-btn').addEventListener('click', async () => {
  if (!requireName()) return;
  const text = $('request-text').value.trim();
  if (!text) return alert('Please type a message first.');
  const requests = JSON.parse(localStorage.getItem('azim_user_requests') || '[]');
  requests.unshift({ user: currentUser, text, date: new Date().toLocaleString() });
  localStorage.setItem('azim_user_requests', JSON.stringify(requests));
  $('request-text').value = '';
  alert('Request submitted! Azim will see it in the Admin Panel.');
  try {
    await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: currentUser, text })
    });
  } catch (e) { /* non-blocking */ }
});

/* ------------------------------------------------------------------ */
/* PROFESSIONAL UPLOAD SYSTEM                                          */
/* ------------------------------------------------------------------ */
let currentKind = 'audio';
let currentSource = 'device';
let currentThumbSource = 'url';
let selectedMediaFiles = [];
let selectedThumbFile = null;
let queueItems = [];      // { key, name, kindLabel, status, progress, error, data }
let uploading = false;

function kindIsVideo() { return currentKind === 'video'; }
function kindIsLink() { return currentKind === 'link'; }
function kindName() { return currentKind === 'link' ? 'link' : (kindIsVideo() ? 'movie' : 'song'); }
function typeLabel() { return kindIsLink() ? 'Link' : (kindIsVideo() ? 'Video' : 'Audio'); }

/* Segmented buttons */
document.querySelectorAll('#media-type-seg .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentKind = btn.dataset.kind;
    document.querySelectorAll('#media-type-seg .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderKindPanes();
    $('media-file').accept = kindIsVideo() ? 'video/*' : 'audio/*';
    $('start-upload-btn').textContent = currentSource === 'link' ? 'Add Link' : (kindIsLink() ? 'Add Link' : 'Upload Media');
    updateQueueTitle();
  });
});

function renderKindPanes() {
  const linkMode = kindIsLink();
  $('device-pane').style.display = (!linkMode && currentSource === 'device') ? 'block' : 'none';
  $('link-pane').style.display = (!linkMode && currentSource === 'link') ? 'block' : 'none';
  $('link-item-pane').style.display = linkMode ? 'block' : 'none';
  $('thumb-block-root').style.display = linkMode ? 'none' : 'block';
}

document.querySelectorAll('#source-seg .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentSource = btn.dataset.source;
    document.querySelectorAll('#source-seg .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderKindPanes();
    $('start-upload-btn').textContent = currentSource === 'link' ? 'Add Link' : (kindIsLink() ? 'Add Link' : 'Upload Media');
  });
});

document.querySelectorAll('#thumb-seg .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentThumbSource = btn.dataset.thumbsrc;
    document.querySelectorAll('#thumb-seg .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $('thumb-url-wrap').style.display = currentThumbSource === 'url' ? 'block' : 'none';
    $('thumb-file-wrap').style.display = currentThumbSource === 'file' ? 'block' : 'none';
    updateThumbPreview();
  });
});

/* File selection */
const mediaFileInput = $('media-file');
const dropZone = $('drop-zone');

$('pick-media-btn').addEventListener('click', (e) => { e.stopPropagation(); mediaFileInput.click(); });
dropZone.addEventListener('click', () => mediaFileInput.click());

['dragenter', 'dragover'].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); });
});
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files.length) {
    selectedMediaFiles = Array.from(e.dataTransfer.files);
    renderSelectedFiles();
  }
});

mediaFileInput.addEventListener('change', () => {
  if (mediaFileInput.files.length) {
    selectedMediaFiles = Array.from(mediaFileInput.files);
    renderSelectedFiles();
  }
});

function renderSelectedFiles() {
  const box = $('selected-files');
  if (selectedMediaFiles.length === 0) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = selectedMediaFiles.map((f, i) => `
    <div class="selected-file">
      <span>${kindIsVideo() ? '🎬' : '🎵'}</span>
      <span class="sf-name">${escapeHtml(f.name)}</span>
      <span class="sf-size">${formatSize(f.size)}</span>
      <button type="button" class="sf-remove" data-i="${i}" title="Remove">✕</button>
    </div>`).join('');

  box.querySelectorAll('.sf-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(btn.dataset.i);
      selectedMediaFiles.splice(i, 1);
      renderSelectedFiles();
    });
  });

  const titleInput = $('media-title');
  if (!titleInput.value.trim() && selectedMediaFiles.length === 1) {
    const name = selectedMediaFiles[0].name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    titleInput.value = name.charAt(0).toUpperCase() + name.slice(1);
  }
  renderSelectedFilesDropHint();
}

function renderSelectedFilesDropHint() {
  const title = $('media-title').value.trim() || 'Name';
  $('title-hint').innerHTML = selectedMediaFiles.length > 1
    ? 'Multiple files detected — they will be named <strong>“' + escapeHtml(title) + ' 1/2/3…”</strong>. The thumbnail (if set) is applied to all.'
    : 'When uploading multiple files, they are named <strong>“Name 1”, “Name 2”…</strong> using this prefix.';
}

$('media-title').addEventListener('input', renderSelectedFilesDropHint);

/* Thumbnail file */
const thumbFileInput = $('thumb-file');
$('pick-thumb-btn').addEventListener('click', (e) => { e.stopPropagation(); thumbFileInput.click(); });
thumbFileInput.addEventListener('change', () => {
  if (thumbFileInput.files.length) {
    selectedThumbFile = thumbFileInput.files[0];
    $('thumb-file-name').textContent = selectedThumbFile.name;
    updateThumbPreview();
  }
});

$('thumb-clear-btn').addEventListener('click', () => {
  selectedThumbFile = null;
  $('thumb-url').value = '';
  $('thumb-file-name').textContent = 'No image selected';
  updateThumbPreview();
});

$('thumb-url').addEventListener('input', updateThumbPreview);

function getThumbnailUrlValue() {
  return currentThumbSource === 'url' ? $('thumb-url').value.trim() : '';
}

function updateThumbPreview() {
  const preview = $('thumb-preview');
  const img = $('thumb-preview-img');
  const thumbVal = currentThumbSource === 'url'
    ? $('thumb-url').value.trim()
    : (selectedThumbFile ? URL.createObjectURL(selectedThumbFile) : '');

  if (currentThumbSource === 'file' && selectedThumbFile) {
    preview.style.display = 'inline-block';
    img.src = thumbVal;
    return;
  }
  if (currentThumbSource === 'url' && thumbVal) {
    preview.style.display = 'inline-block';
    img.src = thumbVal;
    return;
  }
  preview.style.display = 'none';
  img.src = '';
}

/* ------------------------------------------------------------------ */
/* LINKS LIBRARY upload (title + URL + thumbnail)                      */
/* ------------------------------------------------------------------ */
let currentLinkThumbSource = 'url';
let selectedLinkThumbFile = null;

document.querySelectorAll('#link-thumb-seg .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentLinkThumbSource = btn.dataset.lthumb;
    document.querySelectorAll('#link-thumb-seg .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $('link-thumb-url-wrap').style.display = currentLinkThumbSource === 'url' ? 'block' : 'none';
    $('link-thumb-file-wrap').style.display = currentLinkThumbSource === 'file' ? 'block' : 'none';
    updateLinkThumbPreview();
  });
});

const linkThumbFileInput = $('link-thumb-file');
$('pick-link-thumb-btn').addEventListener('click', (e) => { e.stopPropagation(); linkThumbFileInput.click(); });
linkThumbFileInput.addEventListener('change', () => {
  if (linkThumbFileInput.files.length) {
    selectedLinkThumbFile = linkThumbFileInput.files[0];
    $('link-thumb-file-name').textContent = selectedLinkThumbFile.name;
    updateLinkThumbPreview();
  }
});

$('link-thumb-clear-btn').addEventListener('click', () => {
  selectedLinkThumbFile = null;
  $('link-thumb-url').value = '';
  $('link-thumb-file-name').textContent = 'No image selected';
  updateLinkThumbPreview();
});

$('link-thumb-url').addEventListener('input', updateLinkThumbPreview);

function getLinkThumbUrlValue() {
  return currentLinkThumbSource === 'url' ? $('link-thumb-url').value.trim() : '';
}

function updateLinkThumbPreview() {
  const preview = $('link-thumb-preview');
  const img = $('link-thumb-preview-img');
  const thumbVal = currentLinkThumbSource === 'url'
    ? $('link-thumb-url').value.trim()
    : (selectedLinkThumbFile ? URL.createObjectURL(selectedLinkThumbFile) : '');

  if ((currentLinkThumbSource === 'file' && selectedLinkThumbFile) || (currentLinkThumbSource === 'url' && thumbVal)) {
    preview.style.display = 'inline-block';
    img.src = thumbVal;
    return;
  }
  preview.style.display = 'none';
  img.src = '';
}

async function startLinkItemUpload() {
  if (!requireName()) return;
  const title = $('link-item-title').value.trim();
  const url = $('link-item-url').value.trim();
  if (!url) { alert('Please enter the download URL.'); return; }

  const key = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  queueItems.push({ key, name: title || url, kindLabel: 'Link', status: 'uploading', progress: 50, progressText: 'Adding link…' });
  renderQueue();

  const formData = new FormData();
  formData.append('title', title || 'Untitled');
  formData.append('url', url);
  formData.append('uploader', currentUser || 'Anonymous');
  const thumbUrl = getLinkThumbUrlValue();
  if (thumbUrl) formData.append('thumbnailUrl', thumbUrl);
  if (currentLinkThumbSource === 'file' && selectedLinkThumbFile) formData.append('thumbnailFile', selectedLinkThumbFile);

  try {
    const res = await fetch('/api/upload/link-item', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      updateQueueProgress(key, 100, { status: 'done', data: data.item });
      addHistoryItem(data.item, 'link');
      $('link-item-title').value = '';
      $('link-item-url').value = '';
      $('link-thumb-url').value = '';
      selectedLinkThumbFile = null;
      $('link-thumb-file-name').textContent = 'No image selected';
      updateLinkThumbPreview();
    } else {
      updateQueueProgress(key, 100, { status: 'error', error: data.error || ('Link upload failed (' + res.status + ')') });
    }
  } catch (e) {
    updateQueueProgress(key, 100, { status: 'error', error: 'Network error: ' + e.message });
  }
}

/* Queue UI */
function updateQueueTitle() {
  $('queue-title').textContent = `${typeLabel()} Upload Queue`;
}

function queueStatusText() {
  if (uploading) return 'Uploading…';
  const pending = queueItems.filter((q) => q.status === 'waiting').length;
  const done = queueItems.filter((q) => q.status === 'done').length;
  const err = queueItems.filter((q) => q.status === 'error').length;
  if (queueItems.length === 0) return 'Ready';
  return `${done} done · ${pending} waiting${err ? ' · ' + err + ' failed' : ''}`;
}

function renderQueue() {
  $('queue-empty').style.display = queueItems.length ? 'none' : 'block';
  const box = $('upload-queue');
  box.querySelectorAll('.queue-item').forEach((el) => el.remove());

  const frag = document.createDocumentFragment();
  queueItems.forEach((q) => {
    const el = document.createElement('div');
    el.className = 'queue-item ' + (q.status === 'done' ? 'done' : q.status === 'error' ? 'error' : '');
    el.dataset.key = q.key;

    let stateText = '';
    let stateCls = '';
    if (q.status === 'waiting') { stateText = 'Waiting'; stateCls = 'waiting'; }
    else if (q.status === 'uploading') { stateText = q.progressText || 'Uploading…'; stateCls = 'uploading'; }
    else if (q.status === 'done') { stateText = 'Done ✓'; stateCls = 'done'; }
    else if (q.status === 'error') { stateText = 'Failed'; stateCls = 'error'; }

    let meta = `<span>${escapeHtml(q.name)}</span>`;
    if (q.status === 'done' && q.data) {
      const url = q.data.songUrl || q.data.movieUrl || q.data.url || '';
      const action = q.data.url ? 'Download' : (q.data.songUrl ? 'Listen' : 'Watch');
      meta = `<span><a href="${escapeHtml(url)}" target="_blank" rel="noopener">⬇ ${action}</a>`
        + ` · <a href="${escapeHtml(url)}" target="_blank">Open</a></span>`;
    } else if (q.status === 'error' && q.error) {
      meta = `<span title="${escapeHtml(q.error)}">${escapeHtml(q.error)}</span>`;
    } else if (q.status === 'uploading' && q.loaded) {
      meta = `<span>${formatSize(q.loaded)}</span>`;
    }

    const icon = kindIsLink() || q.data?.url ? '🔗' : (kindIsVideo() ? '🎬' : '🎵');
    el.innerHTML = `
      <div class="qi-top"><span class="qi-name">${icon} ${escapeHtml(q.name)}</span><span class="qi-state ${stateCls}">${stateText}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${q.progress}%"></div></div>
      <div class="qi-meta">${meta}</div>`;

    frag.appendChild(el);
  });
  box.appendChild(frag);
  $('queue-status').textContent = queueStatusText();
}

function updateQueueProgress(key, progress, extra) {
  const q = queueItems.find((i) => i.key === key);
  if (!q) return;
  q.progress = progress;
  if (extra) Object.assign(q, extra);
  renderQueue();
}

/* submit */
$('start-upload-btn').addEventListener('click', () => {
  if (kindIsLink()) { startLinkItemUpload(); return; }
  if (currentSource === 'device') startDeviceUpload();
  else startLinkUpload();
});

async function startDeviceUpload() {
  if (!requireName()) return;
  if (selectedMediaFiles.length === 0) { alert('Please choose at least one audio/video file.'); return; }
  if (uploading) { alert('An upload is already in progress. Please wait.'); return; }

  const baseTitle = $('media-title').value.trim();
  const thumbValue = getThumbnailUrlValue();
  const files = selectedMediaFiles.slice();
  uploading = true;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let title;
    if (files.length === 1) title = baseTitle || file.name.replace(/\.[^.]+$/, '') || 'Untitled';
    else if (baseTitle) title = `${baseTitle} ${i + 1}`;
    else title = file.name.replace(/\.[^.]+$/, '') || 'Untitled';

    await uploadOneFile(file, title, kindName(), thumbValue);
  }

  uploading = false;
  if (queueItems.every((q) => q.status === 'done')) {
    selectedMediaFiles = [];
    renderSelectedFiles();
    $('media-title').value = '';
  }
  renderQueue();
}

function uploadOneFile(file, title, type, thumbnailUrl) {
  return new Promise((resolve) => {
    const key = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    queueItems.push({ key, name: title, kindLabel: typeLabel(), status: 'waiting', progress: 0, error: '' });
    renderQueue();

    const formData = new FormData();
    formData.append('mediaFile', file);
    formData.append('type', type);
    formData.append('title', title);
    formData.append('uploader', currentUser || 'Anonymous');
    if (thumbnailUrl) formData.append('thumbnailUrl', thumbnailUrl);
    if (currentThumbSource === 'file' && selectedThumbFile) formData.append('thumbnailFile', selectedThumbFile);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    updateQueueProgress(key, 3, { status: 'uploading', progressText: 'Uploading…' });

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
      updateQueueProgress(key, pct, { progressText: pct + '%', loaded: e.loaded });
    };

    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = { error: xhr.responseText }; }
      if (xhr.status >= 200 && xhr.status < 300 && data.success) {
        updateQueueProgress(key, 100, { status: 'done', data: data.item });
        addHistoryItem(data.item, type);
      } else {
        updateQueueProgress(key, 100, { status: 'error', error: data.error || ('Upload failed (' + xhr.status + ')') });
      }
      resolve();
    };

    xhr.onerror = () => {
      updateQueueProgress(key, 100, { status: 'error', error: 'Network error during upload.' });
      resolve();
    };

    xhr.onabort = () => {
      updateQueueProgress(key, 100, { status: 'error', error: 'Upload aborted.' });
      resolve();
    };

    xhr.send(formData);
  });
}

function addHistoryItem(item, type) {
  const history = $('upload-history');
  const href = item.songUrl || item.movieUrl || item.url || '#';
  const box = document.createElement('div');
  box.className = 'queue-item done';
  box.style.marginTop = '10px';
  box.innerHTML = `
    <div class="qi-top">
      <span class="qi-name">✅ ${escapeHtml(item.title)}</span>
      <span class="qi-state done">Added</span>
    </div>
    <div class="qi-meta">
      <span>${type === 'link' ? 'Link' : (type === 'movie' ? 'Video' : 'Audio')} · By ${escapeHtml(item.uploader || 'Anonymous')}</span>
      <span><a href="${escapeHtml(href)}" target="_blank" rel="noopener">Open ↗</a></span>
    </div>`;
  history.prepend(box);

  fetchGlobalTracks();
  fetchGlobalMovies();
  fetchGlobalLinks();
}

async function startLinkUpload() {
  if (!requireName()) return;
  const mediaUrl = $('media-url').value.trim();
  if (!mediaUrl) { alert('Please enter the direct media URL.'); return; }

  if (!isAdminUnlocked) {
    const ok = await ensureAdmin();
    if (!ok) return;
  }
  const title = $('media-title').value.trim() || 'Untitled';
  const thumbUrl = getThumbnailUrlValue();

  const key = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  queueItems.push({ key, name: title, kindLabel: typeLabel(), status: 'uploading', progress: 50, progressText: 'Adding link…' });
  renderQueue();

  const formData = new FormData();
  formData.append('type', kindName());
  formData.append('title', title);
  formData.append('uploader', currentUser || 'Anonymous');
  formData.append('mediaUrl', mediaUrl);
  if (thumbUrl) formData.append('thumbnailUrl', thumbUrl);
  if (currentThumbSource === 'file' && selectedThumbFile) formData.append('thumbnailFile', selectedThumbFile);
  formData.append('adminSecret', adminSecret);

  try {
    const res = await fetch('/api/upload/link', { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      updateQueueProgress(key, 100, { status: 'done', data: data.item });
      addHistoryItem(data.item, kindName());
    } else {
      updateQueueProgress(key, 100, { status: 'error', error: data.error || ('Link upload failed (' + res.status + ')') });
    }
  } catch (e) {
    updateQueueProgress(key, 100, { status: 'error', error: 'Network error: ' + e.message });
  }
}

/* ------------------------------------------------------------------ */
/* COMMUNITY CHAT                                                      */
/* ------------------------------------------------------------------ */
let lastMessageId = '';
let renderedDayKey = '';
let chatName = '';

function formatChatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dayKey(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dayLabel(key) {
  const date = new Date(key);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - key) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

async function loadMessages({ force } = {}) {
  try {
    const res = await fetch('/api/messages');
    const data = await res.json();
    const messages = data.messages || [];
    if (!force && messages.length && lastMessageId === messages[messages.length - 1].id) return;

    if (!force && messages.length && lastMessageId && messages[messages.length - 1].id !== lastMessageId) {
      fireChatNotification(messages[messages.length - 1]);
    }

    const container = $('chat-messages');
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;

    if (messages.length === 0) {
      container.innerHTML = '<div class="chat-loading">No messages yet. Say hello! 👋</div>';
      lastMessageId = '';
      chatName = currentUser || 'Anonymous';
      $('chat-stats').textContent = 'Live chat · 0 messages';
      $('menu-message-count').textContent = '';
      return;
    }

    lastMessageId = messages[messages.length - 1].id;
    chatName = currentUser || 'Anonymous';
    $('menu-message-count').textContent = messages.length;

    let html = '';
    let lastDay = '';
    const chatPage = $('page-chat');
    const chatVisible = chatPage && chatPage.classList.contains('active');
    messages.forEach((m) => {
      const dk = dayKey(m.timestamp);
      if (dk !== lastDay) {
        html += `<div class="chat-day-divider"><span>${escapeHtml(dayLabel(dk))}</span></div>`;
        lastDay = dk;
      }
      const own = m.user === chatName;
      const eyes = (isAdminUnlocked || isBossUnlocked) ? seenHtml(m) : '';
      html += `
        <div class="msg-row ${own ? 'own' : ''}">
          <div class="msg-avatar">${escapeHtml((m.user || '?').charAt(0))}</div>
          <div class="msg-bubble">
            <div class="msg-user">${escapeHtml(m.user)}${own ? ' · you' : ''}</div>
            <div class="msg-text">${escapeHtml(m.text)}</div>
            <div class="msg-time">${formatChatTime(m.timestamp)}</div>
            ${eyes}
          </div>
        </div>`;
      if (chatVisible && currentUser && m.user !== currentUser) markSeen('message', m.id);
    });

    container.innerHTML = html;
    $('chat-stats').textContent = `Live chat · ${messages.length} message${messages.length === 1 ? '' : 's'}`;

    if (force || nearBottom) container.scrollTop = container.scrollHeight;
  } catch (e) { /* ignore transient errors */ }
}

function scrollChatToBottom() {
  const container = $('chat-messages');
  container.scrollTop = container.scrollHeight;
}

async function sendMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!requireName()) return;

  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: currentUser, text })
    });
    const data = await res.json();
    if (data.success) {
      input.value = '';
      input.style.height = 'auto';
      await loadMessages({ force: true });
    } else {
      alert(data.error || 'Failed to send message.');
    }
  } catch (e) {
    alert('Network error while sending: ' + e.message);
  }
}

$('chat-send-btn').addEventListener('click', sendMessage);
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$('chat-input').addEventListener('input', () => {
  const el = $('chat-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
});

$('clear-chat-btn').addEventListener('click', async () => {
  if (!isAdminUnlocked) return;
  if (!confirm('Clear ALL chat messages?')) return;
  const res = await fetch('/api/messages/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminSecret })
  });
  const data = await res.json();
  if (data.success) {
    lastMessageId = '';
    loadMessages({ force: true });
  } else {
    alert(data.error || 'Clear failed.');
  }
});

setInterval(() => loadMessages(), 3500);

/* ------------------------------------------------------------------ */
/* FIREBASE CLOUD MESSAGING — PUSH NOTIFICATIONS                       */
/* ------------------------------------------------------------------ */
let firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "azim-studio-chat.firebaseapp.com",
  projectId: "azim-studio-chat",
  storageBucket: "azim-studio-chat.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
  vapidKey: "YOUR_VAPID_KEY"
};
let messagingConfigured = false;

let messaging = null;
let fcmToken = null;
const NOTIF_DISMISS_KEY = 'azim_notif_dismissed';

function isSecureContext() {
  return window.isSecureContext && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
}

function notificationsSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator && isSecureContext();
}

async function fetchMessagingConfig() {
  try {
    const res = await fetch('/api/notify/config');
    const data = await res.json();
    if (data.firebaseConfig) {
      firebaseConfig = Object.assign({}, data.firebaseConfig, { vapidKey: data.vapidKey || firebaseConfig.vapidKey });
    }
    messagingConfigured = !!data.messagingConfigured;
  } catch (e) { /* keep defaults */ }
}

async function initMessaging() {
  await fetchMessagingConfig();
  if (!notificationsSupported()) {
    setNotifStatus('Notifications need a secure (HTTPS) connection and a supported browser.', 'unsupported');
    return;
  }
  try {
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
    messaging = firebase.messaging();
    await registerServiceWorker();
    const perm = Notification.permission;
    if (perm === 'granted') {
      await getAndStoreToken();
    } else if (perm === 'denied') {
      setNotifStatus('Notifications are blocked. Use the browser’s site settings to allow them.', 'off');
    } else {
      setNotifStatus('Notifications are available. Tap the button below to enable.', 'off');
      maybePromptForNotifications();
    }
    setupForegroundListener();
  } catch (e) {
    setNotifStatus('Firebase messaging not configured. Add your FCM keys on the server.', 'unsupported');
  }
}

/* Friendly, non-intrusive prompt: shown once; "Not Now" silences it (until
   the user chooses to enable from the Notifications page). */
function maybePromptForNotifications() {
  const banner = $('notif-prompt-banner');
  if (!banner) return;
  if (Notification.permission !== 'default') return;   // granted or denied
  if (localStorage.getItem(NOTIF_DISMISS_KEY) === '1') return; // "Not Now" already chosen
  banner.classList.remove('hidden');
}

async function enableNotifications() {
  if (!notificationsSupported()) { alert('Notifications are not supported in this browser or connection.'); return; }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    localStorage.removeItem(NOTIF_DISMISS_KEY);
    const banner = $('notif-prompt-banner');
    if (banner) banner.classList.add('hidden');
    await registerServiceWorker();
    await getAndStoreToken();
    setupForegroundListener();
    return true;
  }
  if (perm === 'denied') {
    setNotifStatus('Notifications are blocked. Enable them in your browser’s site settings, then return here.', 'off');
  } else {
    setNotifStatus('Notification prompt dismissed. You can try again anytime.', 'off');
  }
  return false;
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    let reg = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js');
    if (!reg) reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
    return reg;
  } catch (e) {
    return null;
  }
}

async function getAndStoreToken() {
  if (!messaging) return null;
  try {
    fcmToken = await messaging.getToken({ vapidKey: firebaseConfig.vapidKey });
    if (fcmToken) {
      await fetch('/api/notify/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fcmToken, name: currentUser || 'Guest' })
      });
      setNotifStatus('Notifications enabled. You’ll be notified of new activity.', 'on');
      return fcmToken;
    }
  } catch (e) {
    setNotifStatus('Could not enable notifications: ' + (e && e.message ? e.message : 'unknown error'), 'off');
  }
  return null;
}

async function disableNotifications() {
  if (fcmToken) {
    try {
      await fetch('/api/notify/unregister', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fcmToken })
      });
    } catch (e) { /* ignore */ }
  }
  fcmToken = null;
  setNotifStatus('Notifications disabled. You can re-enable anytime.', 'off');
}

function updateNotifButton() {
  const btn = $('enable-notif-btn');
  if (!btn) return;
  if (Notification && Notification.permission === 'granted') {
    btn.textContent = 'Disable Notifications';
    btn.className = 'btn-primary btn-lg btn-danger';
  } else {
    btn.textContent = 'Enable Notifications';
    btn.className = 'btn-primary btn-lg';
  }
}

function setNotifStatus(text, state) {
  const el = $('notif-status-text');
  const dot = document.querySelector('.notif-status-dot');
  if (!el) return;
  el.textContent = text;
  if (dot) {
    dot.className = 'notif-status-dot';
    if (state) dot.classList.add(state);
  }
  updateNotifButton();
}

if ($('enable-notif-btn')) {
  $('enable-notif-btn').addEventListener('click', async () => {
    if (Notification && Notification.permission === 'granted') {
      await disableNotifications();
    } else {
      await enableNotifications();
    }
  });
}
if ($('notif-prompt-enable')) {
  $('notif-prompt-enable').addEventListener('click', async () => {
    const ok = await enableNotifications();
    if (!ok && Notification.permission === 'default') {
      const banner = $('notif-prompt-banner');
      if (banner) banner.classList.add('hidden');
    }
  });
}
if ($('notif-prompt-later')) {
  $('notif-prompt-later').addEventListener('click', () => {
    localStorage.setItem(NOTIF_DISMISS_KEY, '1');
    const banner = $('notif-prompt-banner');
    if (banner) banner.classList.add('hidden');
  });
}

/* Foreground message handling (tab is open): just route silently */
function setupForegroundListener() {
  if (!messaging) return;
  try {
    messaging.onMessage((payload) => {
      const url = (payload.data && payload.data.url) || '/';
      openNotificationUrl(url);
    });
  } catch (e) { /* ignore */ }
}

function openNotificationUrl(url) {
  try {
    const params = new URLSearchParams((url.split('?')[1] || ''));
    const target = params.get('page') || 'home';
    if ($('page-' + target)) {
      navigateTo(navigatePageName(target), null);
    }
  } catch (e) { /* ignore */ }
}
function navigatePageName(p) {
  if (p === 'library' || p === 'movies' || p === 'links') return p;
  if (p === 'chat') return 'chat';
  if (p === 'admin') return 'admin';
  if (p === 'notifications') return 'notifications';
  if (p === 'request') return 'request';
  if (p === 'upload') return 'upload';
  return 'home';
}

/* Admin / Boss: send an announcement to all users */
$('send-notif-btn').addEventListener('click', async () => {
  if (!isAdminUnlocked && !isBossUnlocked) { alert('Admin access required to send notifications.'); return; }
  const title = $('notif-title').value.trim();
  const body = $('notif-body').value.trim();
  if (!title && !body) { alert('Please enter a title or message.'); return; }
  try {
    const res = await fetch('/api/notify/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, adminSecret })
    });
    const data = await res.json();
    $('notif-send-result').textContent = data.success
      ? ('Sent to ' + data.sent + ' device(s).')
      : (data.error || 'Failed to send.');
    if (data.success) { $('notif-title').value = ''; $('notif-body').value = ''; }
  } catch (e) {
    $('notif-send-result').textContent = 'Network error: ' + e.message;
  }
});

async function sendChatNotification(user, text) {
  try {
    await fetch('/api/notify/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, text })
    });
  } catch (e) { /* non-blocking */ }
}

let chatNotifCooldown = 0;
let lastChatNotifText = '';

async function fireChatNotification(message) {
  const chatPage = $('page-chat');
  const chatActive = chatPage && chatPage.classList.contains('active') && document.hasFocus();
  if (chatActive) return;
  const now = Date.now();
  if (now - chatNotifCooldown < 10000) return;
  if (message && message.text === lastChatNotifText) return;
  chatNotifCooldown = now;
  lastChatNotifText = message ? message.text : '';

  await sendChatNotification(message.user || 'Someone', message.text || '');

  if (Notification && Notification.permission === 'granted') {
    navigator.serviceWorker.ready.then((reg) => {
      reg.showNotification((message.user || 'Someone') + ' messaged in chat', {
        body: message ? message.text : 'Open the chat to see what’s new.',
        icon: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQoQRdoz6Usc2PKiqexO_C5hT0EHm4G85lNGn-dpHeHzg&s=10',
        tag: 'azim-chat-' + now,
        renotify: false,
        data: { url: '/?page=chat' }
      });
    }).catch(() => { /* ignore */ });
  }
}

/* ------------------------------------------------------------------ */
/* "Seen by" tracking                                                  */
/* ------------------------------------------------------------------ */
async function markSeen(type, id) {
  if (!currentUser) return;
  try {
    await fetch('/api/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id, name: currentUser })
    });
  } catch (e) { /* non-blocking */ }
}

function seenHtml(item) {
  if (!item || !Array.isArray(item.seen) || item.seen.length === 0) return '';
  const names = item.seen.map((s) => escapeHtml(s.name)).join(', ');
  return `<div class="seen-by" title="Seen by: ${names}">👁 Seen by ${escapeHtml(names)}</div>`;
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */
checkUserSession();
fetchGlobalTracks();
fetchGlobalMovies();
fetchGlobalLinks();
loadMessages({ force: true });
updateQueueTitle();
initMessaging();
if (isBossName() && (isBossUnlocked || isAdminUnlocked)) applyBossLabeling();