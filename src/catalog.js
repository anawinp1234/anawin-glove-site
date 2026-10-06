export const breakInService = Object.freeze({
  id: 'break-in-service',
  name: 'Break-in service',
  price: 20,
  currencyCode: 'USD',
  copy: 'ANAWIN will loosen and work the leather so your glove arrives practice-ready and easier to close. Break-In Service adds 2–5 business days to processing time. Broken-in gloves are still eligible for return under our return policy.'
});

export function purchasePrice(product, service, includeService) {
  return product.price + (includeService ? service.price : 0);
}

export const localProducts = Object.freeze([
  { id: 'black', name: 'BR16', descriptor: '10.25" Trainer · US Steerhide', pitch: 'Designed to make defensive reps more demanding without sacrificing the feel, control, and response of a traditional glove.', tone: 'Black / Red / Gray', swatches: ['#202326', '#d3423e', '#a7a9a8'], accentColor: '#d3423e', accentBackground: '#f8f1f0', price: 155, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/black${n}.PNG`) },
  { id: 'blue', name: 'OB16', descriptor: '10.25" Trainer · US Steerhide', pitch: 'Designed to make defensive reps more demanding without sacrificing the feel, control, and response of a traditional glove.', tone: 'Baby Blue / Royal / Navy', swatches: ['#b7dce9', '#1956ac', '#202c40'], accentColor: '#2560ae', accentBackground: '#eef6fa', price: 155, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/blue${n}.PNG`) },
  { id: 'brown', name: 'CL16', descriptor: '10.25" Trainer · US Steerhide', pitch: 'Designed to make defensive reps more demanding without sacrificing the feel, control, and response of a traditional glove.', tone: 'Olive Brown / Tan / Brown', swatches: ['#b97941', '#62452e'], accentColor: '#9a622d', accentBackground: '#f8f3eb', price: 155, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/brown${n}.PNG`) }
]);

export function productHandleMap(env = {}) {
  return {
    black: env.VITE_SHOPIFY_BR16_HANDLE || '',
    blue: env.VITE_SHOPIFY_OB16_HANDLE || '',
    brown: env.VITE_SHOPIFY_CL16_HANDLE || ''
  };
}
