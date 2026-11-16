import { BREAK_IN_LEVELS, DEFAULT_BREAK_IN, FULL_SIZE_CONFIGURATION_KEY, FULL_SIZE_SHAPING_FIELDS, GLOVE_WEARING_STYLES,
  fullSizeBreakInService, fullSizeConfiguration, normalizeBreakInOptions } from './catalog.js';

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

const FULL_SIZE_FIELDS = Object.freeze({
  wearingStyle: fullSizeBreakInService.wearingStyles, closure: fullSizeBreakInService.closurePoints,
  ...Object.fromEntries(FULL_SIZE_SHAPING_FIELDS.map(field => [field.key, field.choices])), firmness: fullSizeBreakInService.firmness
});
const EMPTY_FULL_SIZE = Object.freeze({ wearingStyle: '', placement: '', closure: '', thumbShape: '', pinkyShape: '', fingerShape: '', firmness: '', notes: '' });

const carriesBreakIn = (cart, parent, options) => options.type === 'full-size'
  ? !parent.isBreakIn && attribute(parent, FULL_SIZE_CONFIGURATION_KEY) === fullSizeConfiguration(options) &&
    cart.lines.some(child => child.isBreakIn && child.parentLineId === parent.remoteLineId && child.serviceType === 'full-size')
  : !parent.isBreakIn &&
  attribute(parent, '_anawin_break_in_level') === options.level &&
  attribute(parent, '_anawin_wearing_style') === options.wearingStyle &&
  cart.lines.some(child => child.isBreakIn && child.parentLineId === parent.remoteLineId &&
    attribute(child, 'Break-In Level') === options.level &&
    attribute(child, 'Glove Wearing Style') === options.wearingStyle);

// Returns the glove line that Shopify confirmed carries the chosen break-in.
// The selected line wins when it carries it; otherwise Shopify must have moved exactly one
// glove (a split from a multi-glove line, or a merge) into an entry whose matching serviced
// quantity grew since the cart the shopper reviewed.
export function confirmedBreakInParent(cart, productId, options, { lineId = null, before = null } = {}) {
  if (!cart || cart.incomplete) return null;
  const target = lineId && cart.lines.find(line => line.remoteLineId === lineId && !line.isBreakIn);
  if (target && target.productId === productId && carriesBreakIn(cart, target, options)) return target;
  const matching = current => (current?.lines || []).filter(line => line.productId === productId && carriesBreakIn(current, line, options));
  const previous = new Map(matching(before).map(line => [line.remoteLineId, line.quantity]));
  const grown = matching(cart).filter(line => line.quantity > (previous.get(line.remoteLineId) || 0));
  return grown.length === 1 ? grown[0] : null;
}

// The editor field a form control sets, from its radio name or text-field marker.
export function breakInEditorField(control) {
  const name = control?.name || '';
  if (control?.dataset?.breakInText) return control.dataset.breakInText;
  return ({ 'cart-break-in-level': 'level', 'cart-glove-wearing-style': 'wearingStyle', 'cart-full-size-wearing-style': 'wearingStyle',
    'cart-full-size-closure-point': 'closure', 'cart-full-size-thumb-shape': 'thumbShape', 'cart-full-size-pinky-shape': 'pinkyShape',
    'cart-full-size-finger-shape': 'fingerShape', 'cart-full-size-firmness': 'firmness' })[name] || null;
}

const optionsOf = state => state.type === 'full-size'
  ? normalizeBreakInOptions({ type: 'full-size', ...Object.fromEntries(Object.keys(EMPTY_FULL_SIZE).map(key => [key, state[key]])) })
  : normalizeBreakInOptions({ level: state.level, wearingStyle: state.wearingStyle });

// Holds the one cart line whose break-in choices are being added ('add') or changed ('edit'),
// for a trainer or a full-size glove. Edits start from the saved choices; a full-size add starts
// empty so every instruction is a deliberate choice.
// `perform(options)` must resolve to { status: 'ok', cart } or { status: 'error', message }.
export function createBreakInEditor() {
  let state = null;
  return {
    get state() { return state; },
    isOpen(lineId) { return state?.lineId === lineId; },
    open(lineId, productId, { type = 'trainer', mode = 'add', initial = null } = {}) {
      if (state?.submitting) return false;
      const values = type === 'full-size' ? { ...EMPTY_FULL_SIZE, ...(initial || {}) } : { ...DEFAULT_BREAK_IN, ...(initial || {}) };
      if (type === 'full-size') delete values.type;
      state = { lineId, productId, type, mode, ...values, initial: mode === 'edit' ? initial : null,
        submitting: false, error: '', errorField: null };
      return true;
    },
    select(field, value) {
      if (!state || state.submitting) return false;
      if (state.type === 'full-size') {
        if (['placement', 'notes'].includes(field) && typeof value === 'string') state = { ...state, [field]: value.slice(0, 2000) };
        else if (FULL_SIZE_FIELDS[field]?.includes(value)) state = { ...state, [field]: value };
        else return false;
      }
      else if (field === 'level' && BREAK_IN_LEVELS.includes(value)) state = { ...state, level: value };
      else if (field === 'wearingStyle' && GLOVE_WEARING_STYLES.includes(value)) state = { ...state, wearingStyle: value };
      else return false;
      // A changed answer retires the last validation message.
      if (state.error && !state.submitting) state = { ...state, error: '', errorField: null };
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
      try { options = optionsOf(state); }
      catch (error) { state = { ...state, error: error.message, errorField: error.field || null }; return { status: 'invalid', field: error.field || null }; }
      // Saving the choices the glove already has needs no Shopify request.
      if (state.mode === 'edit' && state.initial && JSON.stringify(options) === JSON.stringify(normalizeBreakInOptions(state.initial))) {
        state = null;
        return { status: 'unchanged', options };
      }
      const { productId, mode } = state;
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
        return { status: mode === 'edit' ? 'updated' : 'added', parentLineId: parent.remoteLineId, options };
      }
      const message = outcome?.status === 'error' && outcome.message
        ? `${outcome.message} Your selections are saved.`
        : mode === 'edit' ? 'We could not confirm your break-in changes. Check your cart before trying again.'
          : 'We could not confirm the break-in service was added. Check your cart before trying again.';
      state = { ...state, submitting: false, error: message };
      return { status: 'failed', message };
    }
  };
}

function choice(name, value, note, checked, disabled, escapeHtml) {
  return `<label class="break-in-choice"><input type="radio" name="${name}" value="${escapeHtml(value)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><strong>${escapeHtml(value)}${value === DEFAULT_BREAK_IN.level ? ' <em>Recommended</em>' : ''}</strong><small>${escapeHtml(note)}</small></span></label>`;
}

const FULL_SIZE_HINTS = Object.freeze({
  closure: 'Recommend for me lets the ANAWIN team choose the closure.',
  fingerShape: 'Recommend for me lets the ANAWIN team choose the finger form.',
  shape: 'None leaves this area’s existing shape unchanged. Recommend for me lets the ANAWIN team choose the shape.'
});

function fullSizeGroup(field, name, legend, choices, editor, locked, escapeHtml, hint = '') {
  const invalid = editor.errorField === name;
  return `<fieldset data-break-in-field="${name}" ${locked ? 'disabled' : ''}${invalid ? ' aria-describedby="cart-service-editor-error"' : ''}><legend>${escapeHtml(legend)}</legend>${hint ? `<small class="break-in-hint">${escapeHtml(hint)}</small>` : ''}${choices.map(value =>
    `<label class="break-in-choice"><input type="radio" name="cart-${name}" value="${escapeHtml(value)}" ${editor[field] === value ? 'checked' : ''} ${locked ? 'disabled' : ''}${invalid ? ' aria-invalid="true"' : ''}><span><strong>${escapeHtml(value)}</strong></span></label>`).join('')}</fieldset>`;
}

function fullSizeFields(editor, locked, escapeHtml) {
  const service = fullSizeBreakInService;
  const other = editor.wearingStyle.startsWith('Other');
  const placementInvalid = editor.errorField === 'full-size-finger-placement';
  return fullSizeGroup('wearingStyle', 'full-size-wearing-style', 'How do you wear your glove?', service.wearingStyles, editor, locked, escapeHtml) +
    `<div class="break-in-text-field" data-break-in-field="full-size-finger-placement" ${other ? '' : 'hidden'}><label for="cart-full-size-placement">Describe your finger placement (required)</label><textarea id="cart-full-size-placement" data-break-in-text="placement" rows="3" maxlength="2000" ${locked ? 'disabled' : ''}${placementInvalid ? ' aria-invalid="true" aria-describedby="cart-service-editor-error"' : ''}>${escapeHtml(editor.placement)}</textarea></div>` +
    fullSizeGroup('closure', 'full-size-closure-point', 'Where should the thumb meet when the glove closes?', service.closurePoints, editor, locked, escapeHtml, FULL_SIZE_HINTS.closure) +
    FULL_SIZE_SHAPING_FIELDS.map(field => fullSizeGroup(field.key, field.name, field.label, field.choices, editor, locked, escapeHtml,
      field.key === 'fingerShape' ? FULL_SIZE_HINTS.fingerShape : FULL_SIZE_HINTS.shape)).join('') +
    fullSizeGroup('firmness', 'full-size-firmness', 'How firm do you want the glove?', service.firmness, editor, locked, escapeHtml) +
    `<div class="break-in-text-field"><label for="cart-full-size-notes">Anything else we should know?</label><small id="cart-full-size-notes-help" class="break-in-hint">${escapeHtml(service.notes)}</small><textarea id="cart-full-size-notes" data-break-in-text="notes" rows="3" maxlength="2000" aria-describedby="cart-full-size-notes-help" ${locked ? 'disabled' : ''}>${escapeHtml(editor.notes)}</textarea></div>`;
}

export function renderBreakInEditor({ product, line, editor, serviceProduct, busy, incomplete, money, escapeHtml }) {
  const submitting = editor.submitting;
  const locked = busy || submitting;
  const editing = editor.mode === 'edit';
  const fullSize = editor.type === 'full-size';
  // A price is shown only once Shopify verified an available service variant. Editing keeps the price.
  const verified = editing || serviceProduct.available === true && Number.isFinite(serviceProduct.price);
  const price = !editing && verified ? `+${money(serviceProduct.price, serviceProduct.currencyCode)}` : '';
  const target = line.quantity > 1 ? `1 of ${line.quantity} ${product.name} gloves` : product.name;
  const lineId = escapeHtml(line.remoteLineId);
  const heading = editing ? `Edit break-in for ${escapeHtml(target)}` : `Customize break-in for ${escapeHtml(target)}`;
  const fields = fullSize ? fullSizeFields(editor, locked, escapeHtml)
    : `<fieldset ${locked ? 'disabled' : ''}><legend>Firmness</legend>${BREAK_IN_LEVELS.map(level =>
      choice('cart-break-in-level', level, LEVEL_NOTES[level], editor.level === level, locked, escapeHtml)).join('')}</fieldset>
    <fieldset ${locked ? 'disabled' : ''}><legend>Wearing style</legend>${GLOVE_WEARING_STYLES.map(style =>
      choice('cart-glove-wearing-style', style, STYLE_NOTES[style], editor.wearingStyle === style, locked, escapeHtml)).join('')}</fieldset>`;
  const priceNote = editing ? (line.quantity > 1 ? 'Only this glove changes. The price stays the same.' : 'Changing your choices doesn’t change the price.')
    : verified ? `${fullSize ? 'Full-size break-in' : 'Break-in service'} <strong>${price}</strong> · Adds 2–5 business days.` : 'Break-in service is unavailable right now.';
  const confirm = submitting ? (editing ? 'Saving…' : 'Adding…') : editing ? 'Save changes' : verified ? `Add break-in ${price}` : 'Unavailable';
  return `<form class="cart-service-editor${fullSize ? ' is-full-size' : ''}" data-service-form="${lineId}" aria-labelledby="cart-service-editor-heading" aria-describedby="cart-service-editor-price" ${submitting ? 'aria-busy="true"' : ''} novalidate>
    <h4 id="cart-service-editor-heading" tabindex="-1">${heading}</h4>
    ${fields}
    <p class="cart-service-editor-price" id="cart-service-editor-price">${priceNote}</p>
    <p class="cart-service-editor-error" id="cart-service-editor-error" data-service-error role="alert" tabindex="-1" ${editor.error ? '' : 'hidden'}>${escapeHtml(editor.error)}</p>
    <p class="cart-service-editor-status" data-service-pending role="status" aria-live="polite" tabindex="-1">${submitting ? (editing ? 'Saving your break-in changes…' : 'Adding break-in service…') : ''}</p>
    <div class="cart-service-editor-actions"><button type="submit" class="cart-service-confirm" data-confirm-service="${lineId}" ${locked || incomplete || !verified ? 'disabled' : ''}>${confirm}</button><button type="button" class="cart-service-cancel" data-cancel-service="${lineId}" ${locked ? 'disabled' : ''}>Cancel</button></div>
  </form>`;
}
