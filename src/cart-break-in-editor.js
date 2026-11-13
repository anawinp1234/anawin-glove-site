import { BREAK_IN_LEVELS, DEFAULT_BREAK_IN, GLOVE_WEARING_STYLES, normalizeBreakInOptions } from './catalog.js';

const LEVEL_NOTES = Object.freeze({
  'Firm (40%)': 'Maintains stiffness and structure.',
  'Medium (65%)': 'Balanced feel, some break-in remaining.',
  'Game Ready (90%)': 'Softest feel, easiest closure.'
});
const STYLE_NOTES = Object.freeze({
  Traditional: 'One finger in each stall.',
  'Two in the Pinky (TIP)': 'Two fingers in the pinky stall.'
});

const attribute = (line, key) => line?.attributes?.find(item => item.key === key)?.value;

const carriesBreakIn = (cart, parent, options) => !parent.isBreakIn &&
  attribute(parent, '_anawin_break_in_level') === options.level &&
  attribute(parent, '_anawin_wearing_style') === options.wearingStyle &&
  cart.lines.some(child => child.isBreakIn && child.parentLineId === parent.remoteLineId &&
    attribute(child, 'Break-In Level') === options.level &&
    attribute(child, 'Glove Wearing Style') === options.wearingStyle);

// Returns the glove line that Shopify confirmed carries the chosen trainer break-in.
// The selected line wins; otherwise Shopify must have moved exactly that glove into
// an entry whose matching serviced quantity grew since the cart the shopper reviewed.
export function confirmedBreakInParent(cart, productId, options, { lineId = null, before = null } = {}) {
  if (!cart || cart.incomplete) return null;
  const target = lineId && cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
  if (target) return target.productId === productId && carriesBreakIn(cart, target, options) ? target : null;
  const matching = current => (current?.lines || []).filter(line => line.productId === productId && carriesBreakIn(current, line, options));
  const previous = new Map(matching(before).map(line => [line.remoteLineId, line.quantity]));
  const grown = matching(cart).filter(line => line.quantity > (previous.get(line.remoteLineId) || 0));
  return grown.length === 1 ? grown[0] : null;
}

// Holds the one cart line whose trainer break-in choices are being reviewed.
// `perform(options)` must resolve to { status: 'ok', cart } or { status: 'error', message }.
export function createBreakInEditor() {
  let state = null;
  return {
    get state() { return state; },
    isOpen(lineId) { return state?.lineId === lineId; },
    open(lineId, productId) {
      if (state?.submitting) return false;
      state = { lineId, productId, ...DEFAULT_BREAK_IN, submitting: false, error: '' };
      return true;
    },
    select(field, value) {
      if (!state || state.submitting) return false;
      if (field === 'level' && BREAK_IN_LEVELS.includes(value)) state = { ...state, level: value };
      else if (field === 'wearingStyle' && GLOVE_WEARING_STYLES.includes(value)) state = { ...state, wearingStyle: value };
      else return false;
      return true;
    },
    cancel() {
      if (!state || state.submitting) return null;
      const { lineId } = state;
      state = null;
      return lineId;
    },
    // Closes an editor whose glove line has left the cart.
    prune(lineIds) {
      if (state && !state.submitting && !lineIds.includes(state.lineId)) state = null;
    },
    // `before` is the cart the shopper reviewed; it guards success when Shopify re-keys or merges lines.
    async submit(lineId, perform, before = null) {
      if (!state || state.lineId !== lineId || state.submitting) return { status: 'ignored' };
      let options;
      try { options = normalizeBreakInOptions({ level: state.level, wearingStyle: state.wearingStyle }); }
      catch (error) { state = { ...state, error: error.message }; return { status: 'invalid' }; }
      const { productId } = state;
      state = { ...state, submitting: true, error: '' };
      let outcome;
      try { outcome = await perform(options); }
      catch (error) { outcome = { status: 'error', message: error?.message || '' }; }
      if (outcome?.status === 'ignored') {
        state = { ...state, submitting: false };
        return outcome;
      }
      const parent = outcome?.status === 'ok' ? confirmedBreakInParent(outcome.cart, productId, options, { lineId, before }) : null;
      if (parent) {
        state = null;
        return { status: 'added', parentLineId: parent.remoteLineId, options };
      }
      const message = outcome?.status === 'error' && outcome.message
        ? `${outcome.message} Your selections are saved.`
        : 'We could not confirm the break-in service was added. Check your cart before trying again.';
      state = { ...state, submitting: false, error: message };
      return { status: 'failed', message };
    }
  };
}

function choice(name, value, note, checked, disabled, escapeHtml) {
  return `<label class="break-in-choice"><input type="radio" name="${name}" value="${escapeHtml(value)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><strong>${escapeHtml(value)}${value === DEFAULT_BREAK_IN.level ? ' <em>Recommended</em>' : ''}</strong><small>${escapeHtml(note)}</small></span></label>`;
}

export function renderBreakInEditor({ product, line, editor, serviceProduct, busy, incomplete, money, escapeHtml }) {
  const submitting = editor.submitting;
  const locked = busy || submitting;
  // A price is shown only once Shopify verified an available service variant.
  const verified = serviceProduct.available === true && Number.isFinite(serviceProduct.price);
  const price = verified ? `+${money(serviceProduct.price, serviceProduct.currencyCode)}` : '';
  const target = line.quantity > 1 ? `1 of ${line.quantity} ${product.name} gloves` : product.name;
  const lineId = escapeHtml(line.remoteLineId);
  return `<form class="cart-service-editor" data-service-form="${lineId}" aria-labelledby="cart-service-editor-heading" aria-describedby="cart-service-editor-price" ${submitting ? 'aria-busy="true"' : ''} novalidate>
    <h4 id="cart-service-editor-heading" tabindex="-1">Customize break-in for ${escapeHtml(target)}</h4>
    <fieldset ${locked ? 'disabled' : ''}><legend>Firmness</legend>${BREAK_IN_LEVELS.map(level =>
      choice('cart-break-in-level', level, LEVEL_NOTES[level], editor.level === level, locked, escapeHtml)).join('')}</fieldset>
    <fieldset ${locked ? 'disabled' : ''}><legend>Wearing style</legend>${GLOVE_WEARING_STYLES.map(style =>
      choice('cart-glove-wearing-style', style, STYLE_NOTES[style], editor.wearingStyle === style, locked, escapeHtml)).join('')}</fieldset>
    <p class="cart-service-editor-price" id="cart-service-editor-price">${verified ? `Break-in service <strong>${price}</strong> · Adds 2–5 business days.` : 'Break-in service is unavailable right now.'}</p>
    <p class="cart-service-editor-error" data-service-error role="alert" tabindex="-1" ${editor.error ? '' : 'hidden'}>${escapeHtml(editor.error)}</p>
    <p class="cart-service-editor-status" data-service-pending role="status" aria-live="polite" tabindex="-1">${submitting ? 'Adding break-in service…' : ''}</p>
    <div class="cart-service-editor-actions"><button type="submit" class="cart-service-confirm" data-confirm-service="${lineId}" ${locked || incomplete || !verified ? 'disabled' : ''}>${submitting ? 'Adding…' : verified ? `Add break-in ${price}` : 'Unavailable'}</button><button type="button" class="cart-service-cancel" data-cancel-service="${lineId}" ${locked ? 'disabled' : ''}>Cancel</button></div>
  </form>`;
}
