const toggle=document.querySelector('#toggle-password'),password=document.querySelector('#password');
toggle.addEventListener('click',()=>{const shown=password.type==='password';password.type=shown?'text':'password';toggle.textContent=shown?'Hide':'Show';toggle.setAttribute('aria-pressed',String(shown));});
document.querySelector('form').addEventListener('submit',()=>{const button=document.querySelector('.submit');button.disabled=true;button.textContent='Signing in…';});

