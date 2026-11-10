import { fullSizeProducts, localProducts } from './catalog.js';

export const canonicalOrigin = 'https://anawinofficial.com';

export const productPaths = Object.freeze({
  black: '/product/br16',
  blue: '/product/ob16',
  brown: '/product/cl16',
  'full-mint': '/product/mi26',
  'full-black': '/product/bl50',
  'full-camel': '/product/cm24',
  'full-orange': '/product/or17'
});
const allProducts = [...localProducts, ...fullSizeProducts];
export const productPath = product => productPaths[product.id];

const homeImage = '/images/hero-background.jpg';
const communityImage = '/images/community-social.jpg';
const imageAlts = Object.freeze({
  [communityImage]: 'ANAWIN Community — Built with you, with a cropped glimpse of baseball gloves on the field',
  [homeImage]: 'Black and red ANAWIN glove on grass',
  '/images/black1.PNG': 'BR16 ANAWIN glove in black, red, and gray',
  '/images/blue1.PNG': 'OB16 ANAWIN glove in baby blue, royal, and navy',
  '/images/brown1.PNG': 'CL16 ANAWIN glove in olive brown, tan, and brown',
  ...Object.fromEntries(fullSizeProducts.map(product => [product.images[0].src, product.images[0].alt]))
});
export const socialImageAlt = imagePath => imageAlts[imagePath] || '';

export const seoRoutes = Object.freeze({
  '/': {
    title: 'ANAWIN | Baseball Gloves',
    description: 'Explore ANAWIN training baseball gloves and the story of a brand built with the baseball community.',
    image: homeImage,
    type: 'website'
  },
  '/shop': {
    title: 'Shop Baseball Gloves | ANAWIN',
    description: 'Shop ANAWIN BR16, OB16, and CL16 10.25-inch training gloves and preview our first full-size gloves in mint, black, camel, and orange.',
    image: homeImage,
    type: 'website'
  },
  '/product/br16': {
    title: 'BR16 Black Training Baseball Glove | ANAWIN',
    description: 'Meet the BR16: a black, red, and gray 10.25-inch ANAWIN training glove made with US steerhide leather.',
    image: '/images/black1.PNG',
    type: 'product'
  },
  '/product/ob16': {
    title: 'OB16 Blue Training Baseball Glove | ANAWIN',
    description: 'Meet the OB16: a baby blue, royal, and navy 10.25-inch ANAWIN training glove made with US steerhide leather.',
    image: '/images/blue1.PNG',
    type: 'product'
  },
  '/product/cl16': {
    title: 'CL16 Brown Training Baseball Glove | ANAWIN',
    description: 'Meet the CL16: an olive brown, tan, and brown 10.25-inch ANAWIN training glove made with US steerhide leather.',
    image: '/images/brown1.PNG',
    type: 'product'
  },
  ...Object.fromEntries(fullSizeProducts.map(product => [productPath(product), {
    title: `${product.name} ${product.title} | ANAWIN`,
    description: product.metaDescription,
    image: product.images[0].src,
    type: 'product'
  }])),
  '/about': {
    title: 'About ANAWIN | Built with the Baseball Community',
    description: 'Learn how two friends started ANAWIN and shaped the brand with the baseball community.',
    image: homeImage,
    type: 'website'
  },
  '/community': {
    title: 'ANAWIN Community | Built With You',
    description: 'Join the ANAWIN Discord to talk directly with the team, vote on future baseball glove designs, and connect with the community.',
    image: communityImage,
    type: 'website'
  },
  '/shipping': {
    title: 'Shipping Policy | ANAWIN',
    description: 'ANAWIN ships to the United States, Canada, Australia, Japan, South Korea, Mexico, and the Philippines. International shipping rates are calculated at checkout.',
    image: homeImage,
    type: 'website'
  },
  '/returns': {
    title: 'Returns & Refunds Policy | ANAWIN',
    description: 'Learn about ANAWIN 30-day returns, return eligibility, prepaid return labels, and refund processing.',
    image: homeImage,
    type: 'website'
  },
  '/warranty': {
    title: '1-Year Limited Warranty | ANAWIN',
    description: 'Read the ANAWIN 1-year limited warranty for manufacturing defects and learn how to make a warranty claim.',
    image: homeImage,
    type: 'website'
  },
  '/care': {
    title: 'Baseball Glove Care Guide | ANAWIN',
    description: 'Find ANAWIN tips for cleaning, drying, conditioning, and storing your baseball glove.',
    image: homeImage,
    type: 'website'
  },
  '/break-in': {
    title: 'Breaking In Your Glove | ANAWIN',
    description: 'Read ANAWIN guidance for gradually breaking in and shaping your baseball glove.',
    image: homeImage,
    type: 'website'
  }
});

export const normalizePath = path => path.replace(/\/$/, '') || '/';
export const routeMetadata = path => {
  const normalizedPath = normalizePath(path);
  return Object.hasOwn(seoRoutes, normalizedPath) ? seoRoutes[normalizedPath] : null;
};

const escapeAttribute = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

export function productJsonLd(path) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath.startsWith('/product/') || !routeMetadata(normalizedPath)) return null;
  const product = localProducts.find(item => normalizedPath === productPath(item));
  // Coming-soon gloves are not purchasable, so they get no Product offer markup.
  if (!product) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: routeMetadata(normalizedPath).description,
    image: canonicalOrigin + product.images[0],
    brand: { '@type': 'Brand', name: 'ANAWIN' },
    url: canonicalOrigin + normalizedPath,
    color: product.tone,
    offers: {
      '@type': 'Offer',
      url: canonicalOrigin + normalizedPath,
      priceCurrency: product.currencyCode,
      price: Number(product.price).toFixed(2),
      shippingDetails: usShippingDetails
    }
  };
}

// Mirrors the published Shipping and Returns policies; keep them in sync if either policy changes.
const usShippingDetails = Object.freeze({
  '@type': 'OfferShippingDetails',
  shippingRate: { '@type': 'MonetaryAmount', value: 0, currency: 'USD' },
  shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
  deliveryTime: {
    '@type': 'ShippingDeliveryTime',
    handlingTime: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 3, unitCode: 'DAY' },
    transitTime: { '@type': 'QuantitativeValue', minValue: 3, maxValue: 7, unitCode: 'DAY' }
  }
});

const usReturnPolicy = Object.freeze({
  '@type': 'MerchantReturnPolicy',
  applicableCountry: 'US',
  returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
  merchantReturnDays: 30,
  returnMethod: 'https://schema.org/ReturnByMail',
  returnFees: 'https://schema.org/FreeReturn',
  merchantReturnLink: `${canonicalOrigin}/returns`
});

export function siteJsonLd(path) {
  if (normalizePath(path) !== '/') return null;
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${canonicalOrigin}/#organization`,
      name: 'ANAWIN',
      url: `${canonicalOrigin}/`,
      logo: `${canonicalOrigin}/images/anawin-mark.png`,
      email: 'support@anawinofficial.com',
      sameAs: ['https://www.instagram.com/anawinofficial', 'https://www.tiktok.com/@anawinofficial'],
      hasMerchantReturnPolicy: usReturnPolicy
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'ANAWIN',
      url: `${canonicalOrigin}/`,
      publisher: { '@id': `${canonicalOrigin}/#organization` }
    }
  ];
}

export function breadcrumbJsonLd(path) {
  const normalizedPath = normalizePath(path);
  const product = allProducts.find(item => normalizedPath === productPath(item));
  if (!product) return null;
  const crumbs = [['Home', '/'], ['Shop', '/shop'], [product.name, normalizedPath]];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map(([name, crumbPath], index) => ({
      '@type': 'ListItem', position: index + 1, name, item: canonicalOrigin + crumbPath
    }))
  };
}

// Each structured-data block is a separate script, marked so client navigation can replace it.
const jsonLdBlocks = path => [
  ['data-anawin-product', productJsonLd(path)],
  ['data-anawin-breadcrumbs', breadcrumbJsonLd(path)],
  ['data-anawin-site', siteJsonLd(path)]
];

const serializeJsonLd = value => JSON.stringify(value).replace(/</g, '\\u003c');

export function renderSeoHead(path) {
  const normalizedPath = normalizePath(path);
  const route = routeMetadata(normalizedPath);
  const title = route?.title || 'Page Not Found | ANAWIN';
  const description = route?.description || 'The requested ANAWIN page could not be found.';
  const image = canonicalOrigin + (route?.image || homeImage);
  const imageAlt = socialImageAlt(route?.image || homeImage);
  const canonical = canonicalOrigin + normalizedPath;
  const lines = [
    `<meta name="description" content="${escapeAttribute(description)}" />`,
    `<title>${escapeAttribute(title)}</title>`,
    ...(route ? [`<link rel="canonical" href="${escapeAttribute(canonical)}" />`] : ['<meta name="robots" content="noindex" />']),
    `<meta property="og:title" content="${escapeAttribute(title)}" />`,
    `<meta property="og:description" content="${escapeAttribute(description)}" />`,
    ...(route ? [`<meta property="og:url" content="${escapeAttribute(canonical)}" />`] : []),
    `<meta property="og:type" content="${route?.type || 'website'}" />`,
    `<meta property="og:image" content="${escapeAttribute(image)}" />`,
    `<meta property="og:image:alt" content="${escapeAttribute(imageAlt)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeAttribute(title)}" />`,
    `<meta name="twitter:description" content="${escapeAttribute(description)}" />`,
    `<meta name="twitter:image" content="${escapeAttribute(image)}" />`,
    `<meta name="twitter:image:alt" content="${escapeAttribute(imageAlt)}" />`
  ];
  for (const [attribute, data] of jsonLdBlocks(normalizedPath)) {
    if (data) lines.push(`<script type="application/ld+json" ${attribute}>${serializeJsonLd(data)}</script>`);
  }
  return lines.join('\n    ');
}

function setMeta(document, selector, attributes, content) {
  const matches = [...document.head.querySelectorAll(selector)];
  const meta = matches.shift() || document.createElement('meta');
  for (const [name, value] of Object.entries(attributes)) meta.setAttribute(name, value);
  meta.setAttribute('content', content);
  if (!meta.isConnected) document.head.append(meta);
  matches.forEach(extra => extra.remove());
}

export function updateSeo(document, path) {
  const normalizedPath = normalizePath(path);
  const route = routeMetadata(normalizedPath);
  const title = route?.title || 'Page Not Found | ANAWIN';
  const description = route?.description || 'The requested ANAWIN page could not be found.';
  const url = canonicalOrigin + normalizedPath;
  const imagePath = route?.image || homeImage;

  document.title = title;
  setMeta(document, 'meta[name="description"]', { name: 'description' }, description);
  setMeta(document, 'meta[property="og:title"]', { property: 'og:title' }, title);
  setMeta(document, 'meta[property="og:description"]', { property: 'og:description' }, description);
  setMeta(document, 'meta[property="og:type"]', { property: 'og:type' }, route?.type || 'website');
  if (route) setMeta(document, 'meta[property="og:url"]', { property: 'og:url' }, url);
  else document.head.querySelectorAll('meta[property="og:url"]').forEach(meta => meta.remove());
  setMeta(document, 'meta[property="og:image"]', { property: 'og:image' }, canonicalOrigin + imagePath);
  setMeta(document, 'meta[property="og:image:alt"]', { property: 'og:image:alt' }, socialImageAlt(imagePath));
  setMeta(document, 'meta[name="twitter:card"]', { name: 'twitter:card' }, 'summary_large_image');
  setMeta(document, 'meta[name="twitter:title"]', { name: 'twitter:title' }, title);
  setMeta(document, 'meta[name="twitter:description"]', { name: 'twitter:description' }, description);
  setMeta(document, 'meta[name="twitter:image"]', { name: 'twitter:image' }, canonicalOrigin + imagePath);
  setMeta(document, 'meta[name="twitter:image:alt"]', { name: 'twitter:image:alt' }, socialImageAlt(imagePath));

  const canonicals = [...document.head.querySelectorAll('link[rel="canonical"]')];
  const canonical = canonicals.shift();
  if (route) {
    const link = canonical || document.createElement('link');
    link.setAttribute('rel', 'canonical');
    link.setAttribute('href', url);
    if (!link.isConnected) document.head.append(link);
  } else canonical?.remove();
  canonicals.forEach(extra => extra.remove());

  const robots = [...document.head.querySelectorAll('meta[name="robots"]')];
  robots.forEach(meta => meta.remove());
  if (!route) setMeta(document, 'meta[name="robots"]', { name: 'robots' }, 'noindex');

  for (const [attribute, data] of jsonLdBlocks(normalizedPath)) {
    const scripts = [...document.head.querySelectorAll(`script[type="application/ld+json"][${attribute}]`)];
    if (data) {
      const script = scripts.shift() || document.createElement('script');
      script.setAttribute('type', 'application/ld+json');
      script.setAttribute(attribute, '');
      script.textContent = serializeJsonLd(data);
      if (!script.isConnected) document.head.append(script);
    }
    scripts.forEach(script => script.remove());
  }
}
