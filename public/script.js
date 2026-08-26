// User Name Logic
const nameInput = document.getElementById('username-input');
const saveBtn = document.getElementById('save-name-btn');
const greeting = document.getElementById('greeting-text');

const savedName = localStorage.getItem('visitorName');
if (savedName) {
  greeting.textContent = `Welcome back, ${savedName}!`;
}

saveBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (name) {
    localStorage.setItem('visitorName', name);
    greeting.textContent = `Welcome, ${name}!`;
    nameInput.value = '';
  }
});

// Request Logic
const requestBtn = document.getElementById('send-request-btn');
const requestText = document.getElementById('request-text');

requestBtn.addEventListener('click', () => {
  const message = requestText.value.trim();
  const currentUser = localStorage.getItem('visitorName') || 'Anonymous User';
  
  if (!message) return alert('Please write a request first!');
  
  alert(`Thank you, ${currentUser}! Your request has been sent to Azim.`);
  requestText.value = '';
});
