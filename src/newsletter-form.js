export function bindNewsletterForm(form, signup, onResult = () => {}) {
  const email = form.elements.email;
  const consent = form.elements.consent;
  const button = form.querySelector('button[type="submit"]');
  const message = form.querySelector('.newsletter-message');
  const fields = form.querySelector('.newsletter-fields');
  const success = form.querySelector('.newsletter-success');

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
      if (result.status === 'success') {
        fields.hidden = true;
        success.hidden = false;
        form.classList.add('is-success');
        const container = form.closest('.newsletter, .newsletter-dialog');
        container?.classList.add('is-success');
        container?.setAttribute('aria-labelledby', success.querySelector('h3').id);
        if (container?.matches('.newsletter-dialog')) container.setAttribute('aria-describedby', success.querySelector('p').id);
        message.classList.add('visually-hidden');
        success.querySelector('h3').focus({ preventScroll: true });
      }
      onResult(result);
    }
  });
}
