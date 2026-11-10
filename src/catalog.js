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

// Full-size gloves are shown as "Coming soon" until they have Shopify listings.
// They are kept out of localProducts so the cart and checkout never see them.
// Colorway names and swatches reflect the approved launch colors.
const fullSizeAngles = Object.freeze([
  ['back', 'back view'],
  ['palm', 'palm view showing the pocket and web'],
  ['side', 'thumb-side view'],
  ['finger-side', 'finger-side view with the ANAWIN wordmark']
]);
// Square photo size per colorway, from scripts/prepare-full-size-images.py.
const fullSizePhotoSizes = Object.freeze({
  mint: { back: 1254, palm: 1254, side: 1254, 'finger-side': 1254 },
  black: { back: 1402, palm: 1402, side: 1448, 'finger-side': 1402 },
  camel: { back: 1449, palm: 1402, side: 724, 'finger-side': 1402 },
  orange: { back: 548, palm: 422, side: 1448, 'finger-side': 567 }
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
  closurePoints: ['Middle finger', 'Ring finger', 'Pinky'],
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
