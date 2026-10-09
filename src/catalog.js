export const breakInService = Object.freeze({
  id: 'break-in-service',
  name: 'Break-in service',
  price: 20,
  currencyCode: 'USD',
  copy: 'ANAWIN will loosen and work the leather so your glove arrives practice-ready and easier to close. Break-In Service adds 2–5 business days to processing time. Broken-in gloves are still eligible for return under our return policy.'
});

export const DEFAULT_BREAK_IN = Object.freeze({ level: 'Medium (65%)', wearingStyle: 'Traditional' });
export const BREAK_IN_LEVELS = Object.freeze(['Firm (40%)', 'Medium (65%)', 'Game Ready (90%)']);
export const GLOVE_WEARING_STYLES = Object.freeze(['Traditional', 'Two in the Pinky (TIP)']);

export function normalizeBreakInOptions(options = DEFAULT_BREAK_IN) {
  if (!BREAK_IN_LEVELS.includes(options?.level) || !GLOVE_WEARING_STYLES.includes(options?.wearingStyle)) {
    throw new Error('Select a break-in level and a glove wearing style.');
  }
  return { level: options.level, wearingStyle: options.wearingStyle };
}

export function serviceAttributes(options = DEFAULT_BREAK_IN) {
  const selected = normalizeBreakInOptions(options);
  return [
    { key: 'Break-In Level', value: selected.level },
    { key: 'Glove Wearing Style', value: selected.wearingStyle }
  ];
}

export function gloveServiceAttributes(options = DEFAULT_BREAK_IN) {
  const selected = normalizeBreakInOptions(options);
  return [
    { key: '_anawin_service', value: 'break-in' },
    { key: '_anawin_break_in_level', value: selected.level },
    { key: '_anawin_wearing_style', value: selected.wearingStyle }
  ];
}

export function cartCustomizationIsComplete(lines = []) {
  const value = (line, key) => {
    const matches = (line.attributes || []).filter(attribute => attribute.key === key);
    return matches.length === 1 ? matches[0].value : null;
  };
  const parents = lines.filter(line => !line.isBreakIn);
  const children = lines.filter(line => line.isBreakIn);
  if (!children.every(child => parents.some(parent => parent.remoteLineId === child.parentLineId))) return false;
  return parents.every(parent => {
    const service = value(parent, '_anawin_service');
    const attached = children.filter(child => child.parentLineId === parent.remoteLineId);
    const level = value(parent, '_anawin_break_in_level');
    const style = value(parent, '_anawin_wearing_style');
    if (service === 'none') return !attached.length && !level && !style;
    if (service !== 'break-in' || attached.length !== 1 ||
      !BREAK_IN_LEVELS.includes(level) || !GLOVE_WEARING_STYLES.includes(style)) return false;
    const child = attached[0];
    return child.productId === parent.productId && child.quantity === parent.quantity &&
      value(child, 'Break-In Level') === level && value(child, 'Glove Wearing Style') === style;
  });
}

export function purchasePrice(product, service, includeService) {
  return product.price + (includeService ? service.price : 0);
}

export const localProducts = Object.freeze([
  { id: 'brown', name: 'CL16', descriptor: '10.25" Trainer · US Steerhide', pitch: 'Designed to make defensive reps more demanding without sacrificing the feel, control, and response of a traditional glove.', tone: 'Olive Brown / Tan / Brown', swatches: ['#b97941', '#62452e'], accentColor: '#9a622d', accentBackground: '#f8f3eb', price: 155, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/brown${n}.PNG`) },
  { id: 'blue', name: 'OB16', descriptor: '10.25" Trainer · US Steerhide', pitch: 'Designed to make defensive reps more demanding without sacrificing the feel, control, and response of a traditional glove.', tone: 'Baby Blue / Royal / Navy', swatches: ['#b7dce9', '#1956ac', '#202c40'], accentColor: '#2560ae', accentBackground: '#eef6fa', price: 155, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/blue${n}.PNG`) },
  { id: 'black', name: 'BR16', descriptor: '10.25" Trainer · US Steerhide', pitch: 'Designed to make defensive reps more demanding without sacrificing the feel, control, and response of a traditional glove.', tone: 'Black / Red / Gray', swatches: ['#202326', '#d3423e', '#a7a9a8'], accentColor: '#d3423e', accentBackground: '#f8f1f0', price: 155, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/black${n}.PNG`) }
]);

export function productHandleMap(env = {}) {
  return {
    black: env.VITE_SHOPIFY_BR16_HANDLE || '',
    blue: env.VITE_SHOPIFY_OB16_HANDLE || '',
    brown: env.VITE_SHOPIFY_CL16_HANDLE || ''
  };
}
