export function bindNewsletterForm(form, signup, onResult = () => {}) {
  const email = form.elements.email;
  const consent = form.elements.consent;
  const button = form.querySelector('button[type="submit"]');
  const message = form.querySelector('.newsletter-message');

  for (const control of [email, consent]) control.addEventListener('input', () => {
    control.removeAttribute('aria-invalid');
    message.textContent = '';
    message.removeAttribute('role');
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (signup.busy) return;
    message.textContent = '';
    message.removeAttribute('role');
    email.removeAttribute('aria-invalid');
    consent.removeAttribute('aria-invalid');
    const resultPromise = signup.submit(email.value, consent.checked);
    if (signup.busy) { button.disabled = true; button.textContent = 'SIGNING UP…'; }
    const result = await resultPromise;
    button.disabled = false;
    button.textContent = 'SIGN UP';
    if (result.status === 'busy') return;
    if (result.status === 'invalid' || result.status === 'error') message.setAttribute('role', 'alert');
    else message.setAttribute('role', 'status');
    message.textContent = result.message;
    if (result.status === 'invalid') {
      const control = result.field === 'email' ? email : consent;
      control.setAttribute('aria-invalid', 'true');
      control.focus();
    }
    if (result.status === 'success' || result.status === 'pending') {
      form.reset();
      onResult(result);
    }
  });
}
