const form = document.getElementById('login-form'), error = document.getElementById('login-error'), button = form.querySelector('button');
form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true; error.hidden = true;
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('password').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'ログインできませんでした');
    location.replace('/');
  } catch (e) {
    error.textContent = e.message; error.hidden = false; button.disabled = false;
    document.getElementById('password').select();
  }
});
