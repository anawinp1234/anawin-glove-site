const EMAIL_PATTERN = /^[^\s@]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export function validateNewsletterSignup(email, consent) {
  const value = String(email ?? '').trim();
  if (!value) return { field: 'email', message: 'Enter your email address.' };
  if (!EMAIL_PATTERN.test(value)) return { field: 'email', message: 'Enter a valid email address.' };
  if (!consent) return { field: 'consent', message: 'Agree to receive marketing emails to sign up.' };
  return null;
}

export function createNewsletterSignup({ fetchImpl = fetch, endpoint = '/api/newsletter' } = {}) {
  let busy = false;
  return {
    get busy() { return busy; },
    async submit(email, consent) {
      if (busy) return { status: 'busy' };
      const invalid = validateNewsletterSignup(email, consent);
      if (invalid) return { status: 'invalid', ...invalid };
      busy = true;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), consent: true })
        });
        if (!response.ok) {
          const failure = await response.json().catch(() => null);
          if (response.status === 400 && failure?.error === 'invalid_email') {
            return { status: 'invalid', field: 'email', message: 'Enter a valid email address.' };
          }
          if (response.status === 400 && failure?.error === 'email_required') {
            return { status: 'invalid', field: 'email', message: 'Enter your email address.' };
          }
          if (response.status === 400 && failure?.error === 'consent_required') {
            return { status: 'invalid', field: 'consent', message: 'Agree to receive marketing emails to sign up.' };
          }
          if (response.status === 429) {
            return { status: 'error', message: 'Too many signup attempts. Please try again shortly.' };
          }
          throw new Error('Signup request failed.');
        }
        const result = await response.json();
        if (result?.marketingState === 'SUBSCRIBED') return { status: 'success', message: 'THANK YOU FOR JOINING OUR COMMUNITY\nYou’re signed up. Keep an eye on your inbox.' };
        if (result?.marketingState === 'PENDING') return { status: 'pending', message: 'Check your email to confirm your signup.' };
        throw new Error('Shopify did not confirm your signup.');
      } catch {
        return { status: 'error', message: 'We couldn’t complete your signup. Please try again later.' };
      } finally {
        busy = false;
      }
    }
  };
}
