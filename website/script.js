function predict() {
  const age = document.getElementById('age').value;
  if (!age) {
    alert('Please enter your age!');
    return;
  }

  document.getElementById('card').classList.add('hidden');
  document.getElementById('hacker').classList.remove('hidden');
  runHackerAnimation(() => {
    document.getElementById('hacker').classList.add('hidden');
    document.getElementById('age-result').textContent = age;
    document.getElementById('result').classList.remove('hidden');
  });
}

function runHackerAnimation(callback) {
  const lines = [
    'INITIALIZING AGE PREDICTION SYSTEM...',
    'C:\\> ACCESSING TOP SECRET DATABASE...',
    'C:\\> LOADING HACKER TOOLS...',
    'C:\\> DECRYPTING YOUR INFORMATION...',
    'C:\\> BYPASSING FIREWALL...',
    'C:\\> HACKING THE MAINFRAME...',
    'C:\\> CALCULATING YOUR AGE...',
    'C:\\> DONE!'
  ];

  const screen = document.querySelector('.hacker-screen');
  screen.innerHTML = '';
  let index = 0;

  const typeLine = () => {
    if (index < lines.length) {
      const p = document.createElement('p');
      p.className = 'typed';
      screen.appendChild(p);
      typeString(p, lines[index], () => {
        index++;
        setTimeout(typeLine, 300);
      });
    } else {
      setTimeout(callback, 500);
    }
  };

  typeLine();
}

function typeString(element, text, callback) {
  let i = 0;
  const interval = setInterval(() => {
    element.textContent += text[i];
    i++;
    if (i >= text.length) {
      clearInterval(interval);
      callback();
    }
  }, 50);
}

function reset() {
  document.getElementById('result').classList.add('hidden');
  document.getElementById('card').classList.remove('hidden');
  document.getElementById('age').value = '';
}
