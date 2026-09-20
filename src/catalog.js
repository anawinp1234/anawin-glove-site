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
  { id: 'black', name: 'BR16', tone: 'Black / Red / Gray', accentColor: '#9a4c52', accentBackground: '#f8f2f2', price: 150, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/black${n}.PNG`) },
  { id: 'blue', name: 'OB16', tone: 'Sky Blue / Royal / Navy', accentColor: '#5d7f9d', accentBackground: '#f1f5f8', price: 150, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/blue${n}.PNG`) },
  { id: 'brown', name: 'CL16', tone: 'Tan / Brown', accentColor: '#8d745b', accentBackground: '#f7f5f2', price: 150, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/brown${n}.PNG`) }
]);

export function productHandleMap(env = {}) {
  return {
    black: env.VITE_SHOPIFY_BR16_HANDLE || '',
    blue: env.VITE_SHOPIFY_OB16_HANDLE || '',
    brown: env.VITE_SHOPIFY_CL16_HANDLE || ''
  };
}
