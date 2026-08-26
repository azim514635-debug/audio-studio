// 1. Multi-Page Navigation & Password Protection
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');
let isAdminUnlocked = false;

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const targetPage = item.getAttribute('data-page');

    // Password Check for Admin Page
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

    // Switch Page View
    navItems.forEach(i => i.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));

    item.classList.add('active');
    document.getElementById(`page-${targetPage}`).classList.add('active');

    if (targetPage === 'admin') loadRequests();
  });
});

// 2. User Profile Setup
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

// 3. User Request Storage System
const sendRequestBtn = document.getElementById('send-request-btn');
const requestText = document.getElementById('request-text');

sendRequestBtn.addEventListener('click', () => {
  const message = requestText.value.trim();
  const currentUser = localStorage.getItem('visitorName') || 'Anonymous Visitor';

  if (!message) return alert('Please write a request first!');

  const requests = JSON.parse(localStorage.getItem('azim_user_requests') || '[]');
  requests.push({
    user: currentUser,
    text: message,
    date: new Date().toLocaleString()
  });

  localStorage.setItem('azim_user_requests', JSON.stringify(requests));
  alert('Your request has been safely sent to Azim!');
  requestText.value = '';
});

// 4. Load Requests into Admin Dialog Box
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

// Clear Requests
document.getElementById('clear-requests-btn').addEventListener('click', () => {
  if (confirm('Clear all stored requests?')) {
    localStorage.removeItem('azim_user_requests');
    loadRequests();
  }
});
