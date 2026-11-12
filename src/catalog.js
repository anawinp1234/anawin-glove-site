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

export const FULL_SIZE_SERVICE_HANDLE = 'full-size-glove-break-in-service';
export const FULL_SIZE_SERVICE_VARIANT = 'gid://shopify/ProductVariant/68062398808312';
export const FULL_SIZE_SERVICE_PRODUCT = 'gid://shopify/Product/15498355474680';
export const FULL_SIZE_SHAPING_FIELDS = Object.freeze([
  { key: 'thumbShape', attribute: 'Thumb Shape', name: 'full-size-thumb-shape', label: 'Thumb shape', choices: ['Straight', 'Flared', 'None', 'Recommend for me'] },
  { key: 'pinkyShape', attribute: 'Pinky Shape', name: 'full-size-pinky-shape', label: 'Pinky shape', choices: ['Straight', 'Flared', 'None', 'Recommend for me'] },
  { key: 'fingerShape', attribute: 'Finger Shape', name: 'full-size-finger-shape', label: 'Finger form', choices: ['Rolled', 'Straight', 'Recommend for me'] }
]);
export const FULL_SIZE_ATTRIBUTE_KEYS = ['Glove Wearing Style', 'Finger Placement', 'Thumb Closure', ...FULL_SIZE_SHAPING_FIELDS.map(field => field.attribute), 'Firmness', 'Notes'];
export const FULL_SIZE_CONFIGURATION_KEY = '_anawin_configuration';
export const SERVICE_ATTRIBUTE_KEYS = ['_anawin_service', '_anawin_break_in_level', '_anawin_wearing_style', '_anawin_service_type', FULL_SIZE_CONFIGURATION_KEY, ...FULL_SIZE_ATTRIBUTE_KEYS];
export function normalizeFullSizeOptions(options) {
  const invalid = (message, field) => { throw Object.assign(new Error(message), { field }); };
  const text = value => String(value ?? '').trim().slice(0, 2000);
  if (!fullSizeBreakInService.wearingStyles.includes(options?.wearingStyle)) invalid('Choose how you wear your glove.', 'full-size-wearing-style');
  if (options.wearingStyle.startsWith('Other') && !text(options.placement)) invalid('Describe your finger placement.', 'full-size-finger-placement');
  if (!fullSizeBreakInService.closurePoints.includes(options.closure)) invalid('Choose where the thumb should meet.', 'full-size-closure-point');
  for (const field of FULL_SIZE_SHAPING_FIELDS) {
    if (!field.choices.includes(options[field.key])) invalid(`Choose ${field.label.toLowerCase()}.`, field.name);
  }
  if (!fullSizeBreakInService.firmness.includes(options.firmness)) invalid('Choose your preferred firmness.', 'full-size-firmness');
  return { type: 'full-size', wearingStyle: options.wearingStyle, placement: options.wearingStyle.startsWith('Other') ? text(options.placement) : '', closure: options.closure, ...Object.fromEntries(FULL_SIZE_SHAPING_FIELDS.map(field => [field.key, options[field.key]])), firmness: options.firmness, notes: text(options.notes) };
}
export function optionsFromAttributes(attributes = [], type = null) {
  const value = key => attributes.find(attribute => attribute.key === key)?.value;
  return (type || value('_anawin_service_type')) === 'full-size' ? {
    type: 'full-size', wearingStyle: value('Glove Wearing Style'), placement: value('Finger Placement'),
    closure: value('Thumb Closure'), ...Object.fromEntries(FULL_SIZE_SHAPING_FIELDS.map(field => [field.key, value(field.attribute)])), firmness: value('Firmness'), notes: value('Notes')
  } : { level: value('_anawin_break_in_level'), wearingStyle: value('_anawin_wearing_style') };
}

export function fullSizeConfiguration(options) {
  return `v1:${configurationDigest(JSON.stringify(normalizeFullSizeOptions(options)))}`;
}

export function normalizeBreakInOptions(options = DEFAULT_BREAK_IN) {
  if (options?.type === 'full-size') return normalizeFullSizeOptions(options);
  if (!BREAK_IN_LEVELS.includes(options?.level) || !GLOVE_WEARING_STYLES.includes(options?.wearingStyle)) {
    throw new Error('Select a break-in level and a glove wearing style.');
  }
  return { level: options.level, wearingStyle: options.wearingStyle };
}

export function serviceAttributes(options = DEFAULT_BREAK_IN) {
  const selected = normalizeBreakInOptions(options);
  if (selected.type === 'full-size') return [
    { key: 'Glove Wearing Style', value: selected.wearingStyle },
    ...(selected.placement ? [{ key: 'Finger Placement', value: selected.placement }] : []),
    { key: 'Thumb Closure', value: selected.closure },
    ...FULL_SIZE_SHAPING_FIELDS.map(field => ({ key: field.attribute, value: selected[field.key] })),
    { key: 'Firmness', value: selected.firmness },
    ...(selected.notes ? [{ key: 'Notes', value: selected.notes }] : [])
  ];
  return [
    { key: 'Break-In Level', value: selected.level },
    { key: 'Glove Wearing Style', value: selected.wearingStyle }
  ];
}

export function gloveServiceAttributes(options = DEFAULT_BREAK_IN) {
  const selected = normalizeBreakInOptions(options);
  if (selected.type === 'full-size') return [{ key: '_anawin_service', value: 'break-in' }, { key: '_anawin_service_type', value: 'full-size' }, { key: FULL_SIZE_CONFIGURATION_KEY, value: fullSizeConfiguration(selected) }];
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
  if (parents.some(parent => parent.parentLineId)) return false;
  if (!children.every(child => parents.some(parent => parent.remoteLineId === child.parentLineId))) return false;
  return parents.every(parent => {
    if (SERVICE_ATTRIBUTE_KEYS.some(key => (parent.attributes || []).filter(attribute => attribute.key === key).length > 1)) return false;
    const service = value(parent, '_anawin_service');
    const attached = children.filter(child => child.parentLineId === parent.remoteLineId);
    const level = value(parent, '_anawin_break_in_level');
    const style = value(parent, '_anawin_wearing_style');
    if (service === 'none') return !attached.length && !level && !style &&
      !SERVICE_ATTRIBUTE_KEYS.filter(key => key !== '_anawin_service').some(key => value(parent, key));
    if (parent.productId?.startsWith('full-')) {
      if (service !== 'break-in' || attached.length !== 1 || level || style || value(parent, '_anawin_service_type') !== 'full-size') return false;
      const child = attached[0];
      if (child.serviceType !== 'full-size' || child.merchandiseId !== FULL_SIZE_SERVICE_VARIANT || child.productId !== parent.productId || child.quantity !== parent.quantity) return false;
      if ([...FULL_SIZE_ATTRIBUTE_KEYS, 'Glove Model', 'Throwing Hand'].some(key => (child.attributes || []).filter(attribute => attribute.key === key).length > 1)) return false;
      const configuration = value(parent, FULL_SIZE_CONFIGURATION_KEY);
      if (configuration !== null) {
        if ([...FULL_SIZE_ATTRIBUTE_KEYS, 'Glove Model', 'Throwing Hand'].some(key => (parent.attributes || []).some(attribute => attribute.key === key))) return false;
        if (!['Right', 'Left'].includes(parent.throwingHand) ||
          value(child, 'Throwing Hand') !== parent.throwingHand ||
          value(child, 'Glove Model') !== fullSizeProducts.find(product => product.id === parent.productId)?.name) return false;
        try {
          const selected = normalizeFullSizeOptions(optionsFromAttributes(child.attributes, 'full-size'));
          const expected = serviceAttributes(selected);
          return configuration === fullSizeConfiguration(selected) &&
            FULL_SIZE_ATTRIBUTE_KEYS.every(key => (value(child, key) || '') === (expected.find(attribute => attribute.key === key)?.value || '')) &&
            !(child.attributes || []).some(attribute => FULL_SIZE_ATTRIBUTE_KEYS.includes(attribute.key) && attribute.value !== attribute.value.trim().slice(0, 2000));
        } catch { return false; }
      }
      // Previously saved carts retain their original layout; reading them never
      // rewrites attributes or alters a previously purchased order.
      if (value(parent, 'Glove Model') !== fullSizeProducts.find(product => product.id === parent.productId)?.name ||
        !['Right', 'Left'].includes(value(parent, 'Throwing Hand')) ||
        parent.throwingHand && parent.throwingHand !== value(parent, 'Throwing Hand') ||
        value(child, 'Glove Model') !== value(parent, 'Glove Model') || value(child, 'Throwing Hand') !== value(parent, 'Throwing Hand')) return false;
      try {
        const selected = normalizeFullSizeOptions(optionsFromAttributes(parent.attributes));
        const expected = serviceAttributes(selected);
        return expected.every(attribute => value(parent, attribute.key) === attribute.value && value(child, attribute.key) === attribute.value) &&
          FULL_SIZE_ATTRIBUTE_KEYS.every(key => (value(parent, key) || '') === (expected.find(attribute => attribute.key === key)?.value || '') &&
            (value(child, key) || '') === (value(parent, key) || '')) &&
          !(parent.attributes || []).some(attribute => FULL_SIZE_ATTRIBUTE_KEYS.includes(attribute.key) && attribute.value !== attribute.value.trim().slice(0, 2000));
      } catch { return false; }
    }
    if (attached.some(child => child.serviceType === 'full-size') || value(parent, '_anawin_service_type')) return false;
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
  { id: 'brown', name: 'CL16', descriptor: '10.25" Trainer · US Steerhide', pitch: 'Designed to make defensive reps more demanding without sacrificing the feel, control, and response of a traditional glove.', tone: 'Camel / Toffee / Black', swatches: ['#b97941', '#62452e'], accentColor: '#9a622d', accentBackground: '#f8f3eb', price: 155, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/brown${n}.PNG`) },
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

// Full-size gloves remain Coming Soon. Optional commerce handles support isolated launch rehearsal.
// Colorway names and swatches reflect the approved launch colors.
const fullSizeAngles = Object.freeze([
  ['back', 'back view'],
  ['palm', 'palm view showing the pocket and web'],
  ['side', 'thumb-side view'],
  ['finger-side', 'finger-side view with the ANAWIN wordmark']
]);
// Square photo size per colorway, from scripts/prepare-full-size-images.py.
const fullSizePhotoSizes = Object.freeze({
  mint: { back: 1254, palm: 1202, side: 1254, 'finger-side': 1254 },
  black: { back: 1271, palm: 1276, side: 1442, 'finger-side': 1208 },
  camel: { back: 1198, palm: 1244, side: 612, 'finger-side': 1119 },
  orange: { back: 1197, palm: 1322, side: 1206, 'finger-side': 1438 }
});
const fullSizePhotos = (color, tone) => fullSizeAngles.map(([angle, view]) => ({
  src: `/images/full-size/${color}-${angle}.jpg`,
  name: `${color}-${angle}`,
  width: fullSizePhotoSizes[color][angle],
  alt: `${tone} full-size ANAWIN glove, ${view}`
}));

export const fullSizeBreakInService = Object.freeze({
  name: 'Full-Service Break-In',
  price: 75,
  currencyCode: 'USD',
  summary: 'Choose your finger placement, how you want the glove to close, and your preferred firmness. You can add notes about how you wear or shape your glove.',
  copy: 'Tell us how you wear your glove and how you want it to close. We’ll break it in and shape it around the setup you choose.',
  timing: 'Allow 2–5 additional business days for processing.',
  wearingStyles: ['Traditional — index finger in', 'Traditional — index finger out', 'Two in the Pinky — index finger in', 'Two in the Pinky — index finger out', 'Other — describe your finger placement'],
  closurePoints: ['Middle finger', 'Ring finger', 'Pinky', 'Recommend for me'],
  firmness: ['Firm', 'Medium', 'Game Ready'],
  notes: 'Optional. Tell us about a glove you’re used to, how you like your pocket shaped, or any other detail you want us to know.'
});

// Throw-hand labels shared by the option list, specs, and setup summary.
export const throwHandLabels = Object.freeze({
  'Right-Hand Throw': 'Right-Hand Throw (worn on left hand)',
  'Left-Hand Throw': 'Left-Hand Throw (worn on right hand)'
});
const rightHandOnly = Object.freeze(['Right-Hand Throw']);
const bothThrowHands = Object.freeze(['Right-Hand Throw', 'Left-Hand Throw']);
const fullSizeSpecs = (size, position, web, details, throwHands) => [
  ['Size', `${size} inches`], ['Position', position], ['Leather', 'Japanese Kip'], ['Web', web],
  ...details, ['Throw hand', throwHands.map(hand => throwHandLabels[hand]).join(' or ')]
];

export const fullSizeProducts = Object.freeze([
  {
    id: 'full-mint', color: 'mint', name: 'MI26', line: 'full-size', comingSoon: true,
    title: 'Mint 12″ Japanese Kip Pitcher’s Glove', descriptor: '12″ Japanese Kip Pitcher’s Glove',
    price: 290, currencyCode: 'USD', throwHands: bothThrowHands,
    pitch: 'A 12-inch Japanese Kip pitcher’s glove with a closed web and an external index finger hood. The solid panel helps keep your grip out of view on the mound, and the carved design on the outside gives this glove its signature look. If you wear your index finger outside the glove, you can tuck it under the hood.',
    specs: fullSizeSpecs('12', 'Pitcher', 'Closed web with a carved outer design', [['Index finger', 'External finger hood'], ['Wrist lining', 'Fur']], bothThrowHands),
    metaDescription: 'ANAWIN Mint is a 12-inch Japanese Kip pitcher’s glove with a carved closed web and index finger hood. Choose right-hand or left-hand throw.',
    tone: 'Mint / Silver', swatches: ['#3fd6a6', '#a9adb0'], accentColor: '#16946d', accentBackground: '#eefaf5', images: fullSizePhotos('mint', 'Mint')
  },
  {
    id: 'full-black', color: 'black', name: 'BL50', line: 'full-size', comingSoon: true,
    title: 'Black 12.75″ Japanese Kip Outfield Glove', descriptor: '12.75″ Japanese Kip Outfield Glove',
    price: 290, currencyCode: 'USD', throwHands: bothThrowHands,
    pitch: 'A 12.75-inch Japanese Kip glove built for the outfield. It’s the longest model in the ANAWIN Kip Series and pairs that extra length with an open H-web. A carved ANAWIN logo on the thumb adds detail to the all-black design.',
    specs: fullSizeSpecs('12.75', 'Outfield', 'H-web', [['Thumb detail', 'Carved ANAWIN logo'], ['Wrist lining', 'Fur']], bothThrowHands),
    metaDescription: 'ANAWIN Black is a 12.75-inch Japanese Kip outfield glove with an H-web and carved thumb logo. Choose right-hand or left-hand throw.',
    tone: 'Black / White / Brown', swatches: ['#1b1c1e', '#ffffff', '#8a5a3a'], accentColor: '#7a4b2e', accentBackground: '#f5f2ef', images: fullSizePhotos('black', 'Black')
  },
  {
    id: 'full-camel', color: 'camel', name: 'CM24', line: 'full-size', comingSoon: true,
    title: 'Camel 11.5″ Japanese Kip Infield Glove', descriptor: '11.5″ Japanese Kip Infield Glove',
    price: 285, currencyCode: 'USD', throwHands: rightHandOnly,
    pitch: 'An 11.5-inch Japanese Kip infield glove with a Diamond web. Camel is the more compact of the two infield models. Inside, every finger stall is lined with sheepskin, and a moisture-wicking pad sits at the wrist.',
    specs: fullSizeSpecs('11.5', 'Infield', 'Diamond web', [['Finger stall lining', 'Sheepskin in all finger stalls'], ['Wrist', 'Moisture-wicking pad']], rightHandOnly),
    metaDescription: 'ANAWIN Camel is an 11.5-inch Japanese Kip infield glove with a Diamond web, sheepskin-lined finger stalls, and a moisture-wicking wrist pad.',
    tone: 'Camel / Red / Black', swatches: ['#e6d6b8', '#c8322b', '#1d1d1d'], accentColor: '#b0322b', accentBackground: '#faf6ef', images: fullSizePhotos('camel', 'Camel')
  },
  {
    id: 'full-orange', color: 'orange', name: 'OR17', line: 'full-size', comingSoon: true,
    title: 'Orange 11.75″ Japanese Kip Infield Glove', descriptor: '11.75″ Japanese Kip Infield Glove',
    price: 290, currencyCode: 'USD', throwHands: bothThrowHands,
    pitch: 'An 11.75-inch Japanese Kip infield glove with a Modified T-web. Orange is the larger of the two infield models in the ANAWIN Kip Series, giving you a quarter inch more length than Camel. The thumb features a carved ANAWIN logo, and the Modified T-web makes sure you swallow every ball in the infield.',
    specs: fullSizeSpecs('11.75', 'Infield', 'Modified T-web', [['Thumb detail', 'Carved ANAWIN logo'], ['Wrist lining', 'Fur']], bothThrowHands),
    metaDescription: 'ANAWIN Orange is an 11.75-inch Japanese Kip infield glove with a Modified T-web, a carved thumb logo, and a fur wrist lining. Choose right-hand or left-hand throw.',
    tone: 'Orange / Gold / Chestnut Brown', swatches: ['#e8732a', '#b9973f', '#70452f'], accentColor: '#c85a17', accentBackground: '#fdf3ec', images: fullSizePhotos('orange', 'Orange')
  }
]);

// Synchronous SHA-256 keeps cart validation synchronous in the browser. The
// fingerprint binds the private parent identity to the service's instructions;
// it is not authentication or a replacement for Shopify's parent relationship.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
const rotate = (x, n) => (x >>> n) | (x << (32 - n));

export function configurationDigest(text) {
  const input = new TextEncoder().encode(text);
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  bytes.set(input); bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, Math.floor(input.length / 0x20000000));
  view.setUint32(bytes.length - 4, input.length * 8);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + words[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => { hash[i] += value; });
  }
  return Array.from(hash, value => value.toString(16).padStart(8, '0')).join('');
}
