const rounded = amount => Math.round((amount + Number.EPSILON) * 1000) / 1000;
const validMoney = (value, currency) => Number.isFinite(value?.amount) && value.amount >= 0 && value.currencyCode === currency;
export const codeKey = code => code.trim().toLocaleLowerCase('en-US');

export function discountCodeList(cart) {
  const seen = new Set();
  return (cart.discountCodes || []).map(item => item.code).filter(code => {
    if (typeof code !== 'string' || !code.trim()) return false;
    const key = codeKey(code);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function applicableDiscountCodes(cart) {
  const seen = new Set();
  return (cart.discountCodes || []).filter(({ code, applicable }) => {
    if (applicable !== true || typeof code !== 'string' || !code.trim()) return false;
    const key = codeKey(code);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function lineDisplayAmounts(line) {
  const original = line.lineSubtotal;
  const costTotal = line.lineTotal;
  const currency = original?.currencyCode;
  if (!currency || !validMoney(original, currency) || !validMoney(costTotal, currency)) return null;
  let allocated = 0;
  for (const allocation of line.allDiscountAllocations || []) {
    if (allocation.targetType !== 'LINE_ITEM') continue;
    if (!validMoney(allocation.amount, currency)) return null;
    allocated += allocation.amount.amount;
  }
  if (allocated > original.amount + 0.01) return null;
  const amount = rounded(Math.min(costTotal.amount, original.amount - allocated));
  return { original, discounted: { amount, currencyCode: currency } };
}

export function entryDisplayAmounts(parent, service = null) {
  const glove = lineDisplayAmounts(parent);
  const child = service ? lineDisplayAmounts(service) : null;
  if (!glove || (service && !child)) return null;
  if (child && glove.original.currencyCode !== child.original.currencyCode) return null;
  return {
    original: { amount: rounded(glove.original.amount + (child?.original.amount || 0)), currencyCode: glove.original.currencyCode },
    discounted: { amount: rounded(glove.discounted.amount + (child?.discounted.amount || 0)), currencyCode: glove.original.currencyCode }
  };
}

export function cartDiscountSummary(cart) {
  const currency = cart.currencyCode;
  const codes = applicableDiscountCodes(cart);
  const lines = cart.lines || [];
  const amounts = lines.map(lineDisplayAmounts);
  if (!Number.isFinite(cart.subtotal) || !currency || amounts.some(value => !value || value.original.currencyCode !== currency)) {
    return { codes, original: null, final: null, savings: null, discounts: [] };
  }
  const originalAmount = rounded(amounts.reduce((sum, value) => sum + value.original.amount, 0));
  const lineFinal = rounded(amounts.reduce((sum, value) => sum + value.discounted.amount, 0));
  if (cart.subtotal < 0 || cart.subtotal > originalAmount + 0.01) {
    return { codes, original: null, final: null, savings: null, discounts: [] };
  }
  // Cart.cost.subtotalAmount excludes cart-level discounts. The all-allocation
  // line totals include them, so use the lower Shopify-provided result.
  const finalAmount = rounded(Math.min(cart.subtotal, lineFinal));
  const savingsAmount = rounded(originalAmount - finalAmount);
  const original = { amount: originalAmount, currencyCode: currency };
  const final = { amount: finalAmount, currencyCode: currency };
  const savings = savingsAmount > 0 ? { amount: savingsAmount, currencyCode: currency } : null;
  if (!savings) return { codes, original, final, savings, discounts: [] };

  const codeAmounts = new Map(codes.map(({ code }) => [codeKey(code), { code, amount: 0 }]));
  for (const line of lines) {
    for (const allocation of line.allDiscountAllocations || []) {
      if (allocation.targetType !== 'LINE_ITEM' || !allocation.code) continue;
      const entry = codeAmounts.get(codeKey(allocation.code));
      if (entry) entry.amount += allocation.amount.amount;
    }
  }
  const allocatedToCodes = rounded([...codeAmounts.values()].reduce((sum, entry) => sum + entry.amount, 0));
  if (allocatedToCodes > savingsAmount + 0.01) {
    return { codes, original, final, savings, discounts: [{ code: null, amount: savings }] };
  }
  const discounts = [...codeAmounts.values()].filter(entry => entry.amount > 0).map(entry => ({
    code: entry.code, amount: { amount: rounded(entry.amount), currencyCode: currency }
  }));
  const remainder = rounded(savingsAmount - allocatedToCodes);
  if (remainder > 0.01) discounts.push({ code: null, amount: { amount: remainder, currencyCode: currency } });
  else if (remainder > 0 && discounts.length) discounts.at(-1).amount.amount = rounded(discounts.at(-1).amount.amount + remainder);
  else if (!discounts.length) discounts.push({ code: null, amount: savings });
  return { codes, original, final, savings, discounts };
}

// Feedback for the Shopify cart returned by one apply or remove. A successful apply is announced
// only, because the applied-code row already shows it.
export function discountResultFeedback(cart, { code = '', removingCode = '' } = {}) {
  const codes = cart.discountCodes || [];
  let message = '';
  let error = false;
  const applied = Boolean(code) && codes.find(item => codeKey(item.code) === codeKey(code))?.applicable === true;
  if (code) {
    message = applied ? `${code} applied.` : 'Discount code isn’t valid for this cart.';
    error = !applied;
  }
  if (removingCode) {
    error = codes.some(item => codeKey(item.code) === codeKey(removingCode));
    message = error ? 'The discount code could not be removed. Please try again.' : 'Discount code removed.';
  }
  // Shopify repeats a rejected code's warning on every later update while that code stays on the
  // cart; its "not applicable" row already says so, so only otherwise-unexplained warnings are shown.
  const warnings = codes.some(item => item.applicable !== true) ? [] : cart.discountWarnings || [];
  if (!error && warnings.length) return { message: [message, ...warnings].filter(Boolean).join(' '), error, announceOnly: false, applied };
  return { message, error, announceOnly: applied, applied };
}

// The entry stays collapsed until asked for, but an error keeps it open.
export const discountEntryExpanded = ({ expanded = false, error = false } = {}) => Boolean(expanded || error);

export function dismissDiscountError(input, message) {
  input?.removeAttribute('aria-invalid');
  if (!message) return;
  message.textContent = '';
  message.classList.remove('cart-error');
  message.setAttribute('role', 'status');
}

export function renderDiscountEntry(cart, { busy = false, blocked = busy, waiting = busy, input = '', message = '', error = false, expanded = false, announceOnly = false } = {}, escapeHtml) {
  if (!cart.id || !cart.lines?.length) return '';
  const codes = discountCodeList(cart);
  const open = discountEntryExpanded({ expanded, error });
  return `<section class="cart-discount-entry" aria-labelledby="discount-toggle"${busy ? ' aria-busy="true"' : ''}>
    <button type="button" id="discount-toggle" class="cart-discount-toggle" data-discount-toggle aria-expanded="${open}" aria-controls="cart-discount-panel">Have a discount code?</button>
    <form id="cart-discount-panel" data-discount-form ${open ? '' : 'hidden'}><label class="visually-hidden" for="cart-discount-input">Discount code</label><input id="cart-discount-input" name="discountCode" type="text" autocomplete="off" placeholder="Enter code" value="${escapeHtml(input)}" ${blocked ? 'disabled' : ''}${error ? ' aria-invalid="true"' : ''} aria-describedby="cart-discount-message"><button type="submit" data-discount-apply ${blocked ? 'disabled' : ''}>${busy ? 'Applying…' : 'Apply'}</button></form>
    ${codes.length ? `<div class="cart-discount-code-list">${codes.map(code => {
      const applicable = cart.discountCodes.find(item => codeKey(item.code) === codeKey(code))?.applicable === true;
      return `<div class="cart-discount-code"><span>${applicable ? '<span aria-hidden="true">✓</span> ' : ''}${escapeHtml(code)} ${applicable ? 'applied' : 'not applicable'}</span><button type="button" data-remove-discount="${escapeHtml(code)}" aria-label="Remove discount code ${escapeHtml(code)}" ${blocked ? 'disabled' : ''}>${busy ? 'Updating…' : 'Remove'}</button></div>`;
    }).join('')}</div>` : ''}
    ${waiting && !busy ? '<p role="status">Wait for your cart update before changing discounts.</p>' : ''}
    <p id="cart-discount-message" class="cart-discount-message${error ? ' cart-error' : ''}${announceOnly && !error ? ' visually-hidden' : ''}" role="${error ? 'alert' : 'status'}">${escapeHtml(message)}</p>
  </section>`;
}

export function renderCartDiscounts(cart, mode, money, escapeHtml) {
  if (mode !== 'shopify') return `<div class="cart-total-row"><span>Subtotal</span><strong>${money(cart.subtotal, cart.currencyCode)}</strong></div>`;
  const { codes, original, final, savings, discounts } = cartDiscountSummary(cart);
  if (!savings) return `<div class="cart-total-row"><span>Subtotal</span><strong>${money(cart.subtotal, cart.currencyCode)}</strong></div>`;
  const rows = discounts.map(({ code, amount }) => `<div class="cart-total-row cart-discount-row"><span>${code ? `Discount (${escapeHtml(code)})` : 'Other discounts'}</span><span>−${money(amount.amount, amount.currencyCode)}</span></div>`).join('');
  return `<div class="cart-total-row"><span>Merchandise subtotal</span><span>${money(original.amount, original.currencyCode)}</span></div>${rows}<div class="cart-total-row cart-final-total"><span>Total before shipping/tax</span><strong>${money(final.amount, final.currencyCode)}</strong></div>`;
}

export function renderCartDiscountSection(cart, mode, state, money, escapeHtml) {
  return `${mode === 'shopify' ? renderDiscountEntry(cart, state, escapeHtml) : ''}${renderCartDiscounts(cart, mode, money, escapeHtml)}`;
}
