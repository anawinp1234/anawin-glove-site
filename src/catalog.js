export const breakInService = Object.freeze({
  id: 'break-in-service',
  name: 'Break-in service',
  price: 20,
  currencyCode: 'USD',
  copy: 'Get your glove ready for practice right away.'
});

export const localProducts = Object.freeze([
  { id: 'black', name: 'BR16', tone: 'Black / Red / Gray', price: 150, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/black${n}.PNG`) },
  { id: 'blue', name: 'OB16', tone: 'Sky Blue / Royal / Navy', price: 150, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/blue${n}.PNG`) },
  { id: 'brown', name: 'CL16', tone: 'Tan / Brown', price: 150, currencyCode: 'USD', available: true, throwingHand: 'Right', wornOnHand: 'Left', images: [1, 2, 3, 4].map(n => `/images/brown${n}.PNG`) }
]);

export function productHandleMap(env = {}) {
  return {
    black: env.VITE_SHOPIFY_BR16_HANDLE || '',
    blue: env.VITE_SHOPIFY_OB16_HANDLE || '',
    brown: env.VITE_SHOPIFY_CL16_HANDLE || ''
  };
}
