const WIDGET_ORIGIN = 'https://cdn.judge.me';
export const JUDGEME_SHOP_DOMAIN = 'ignvv0-zh.myshopify.com';

export function shopifyProductId(gid) {
  const match = /^gid:\/\/shopify\/Product\/([1-9]\d*)$/.exec(gid || '');
  return match?.[1] || null;
}

export function judgeMeWidgetUrl({ publicToken, productId, widget, page = 1 }) {
  if (!publicToken || !/^[1-9]\d*$/.test(productId || '') || !['preview_badge', 'product_review'].includes(widget)) return null;
  const url = new URL(`/api/v1/widgets/${widget}`, WIDGET_ORIGIN);
  url.searchParams.set('shop_domain', JUDGEME_SHOP_DOMAIN);
  url.searchParams.set('api_token', publicToken); // Judge.me's public Widget API uses this parameter name.
  url.searchParams.set('external_id', productId);
  if (widget === 'product_review' && page !== null) {
    url.searchParams.set('json_request', 'true');
    url.searchParams.set('page', String(page));
  }
  return url.toString();
}

const parseHtmlDefault = html => new DOMParser().parseFromString(html, 'text/html');
const countFrom = value => /^\d+$/.test(String(value ?? '')) ? Number(value) : null;
const ratingFrom = value => {
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null;
};
const textOf = (node, selector) => node.querySelector(selector)?.textContent?.trim() || '';
const mediaUrl = url => typeof url === 'string' && url.startsWith('//') ? `https:${url}` : url || '';

export function parseJudgeMeBadge(payload, productId, parseHtml = parseHtmlDefault) {
  if (String(payload?.product_external_id) !== productId || typeof payload.badge !== 'string') return null;
  const badge = parseHtml(payload.badge).querySelector('.jdgm-prev-badge[data-average-rating][data-number-of-reviews]');
  if (!badge) return null;
  const count = countFrom(badge.getAttribute('data-number-of-reviews'));
  const average = ratingFrom(badge.getAttribute('data-average-rating'));
  if (count === null || (count > 0 && (!average || average > 5))) return null;
  return { status: 'ready', count, average: count ? average : null, reviews: [], distribution: null, hasWidget: false };
}

export function parseJudgeMeWidget(payload, productId, count, productHandle, parseHtml = parseHtmlDefault) {
  if (String(payload?.product_external_id) !== productId || typeof payload.widget !== 'string') return null;
  const root = parseHtml(payload.widget);
  const reviewLink = root.querySelector('a.jdgm-write-rev-link[href]')?.getAttribute('href');
  let writeReviewUrl = null;
  if (reviewLink) {
    try {
      const url = new URL(reviewLink);
      if (url.protocol === 'https:' && url.hostname === 'judge.me' && /^\/product_reviews\/[^/]+\/new$/.test(url.pathname)) writeReviewUrl = url.toString();
    } catch { /* Judge.me's script-only # action is not a usable link here. */ }
  }
  const rows = [...root.querySelectorAll('.jdgm-histogram__row[data-rating]')];
  let distribution = null;
  if (rows.length === 5) {
    const values = Object.fromEntries([5, 4, 3, 2, 1].map(rating => [rating, 0]));
    for (const row of rows) {
      const rating = Number(row.getAttribute('data-rating'));
      const frequency = countFrom(row.getAttribute('data-frequency'));
      if (Number.isInteger(rating) && rating >= 1 && rating <= 5 && frequency !== null) values[rating] = frequency;
    }
    if (Object.values(values).reduce((sum, value) => sum + value, 0) === count) distribution = values;
  }
  const fallbackReviews = [...root.querySelectorAll('.jdgm-rev[data-score]')].map(node => {
    const rating = ratingFrom(node.getAttribute('data-score'));
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
    const date = node.querySelector('time')?.getAttribute('datetime') || '';
    return { id: node.getAttribute('data-review-id') || '', productHandle, rating,
      customer: textOf(node, '.jdgm-rev__author'), verified: Boolean(node.querySelector('.jdgm-rev__buyer-badge')),
      date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : '',
      title: textOf(node, '.jdgm-rev__title'), body: textOf(node, '.jdgm-rev__body'),
      media: [...node.querySelectorAll('.jdgm-rev__pics img')].map(image => ({ type: 'image', url: mediaUrl(image.getAttribute('src')), alt: image.getAttribute('alt') || `Customer photo of ${productHandle.toUpperCase()}` })) };
  }).filter(Boolean);
  return { distribution, fallbackReviews, writeReviewUrl };
}

export function parseJudgeMeReviews(payload, productId, productHandle) {
  if (!Array.isArray(payload?.reviews) || !Number.isInteger(payload.total_pages) || payload.total_pages < 0) return null;
  const reviews = payload.reviews.filter(review => review && typeof review === 'object'
    && review.published !== false
    && (review.product_external_id == null || String(review.product_external_id) === productId)).map(review => {
    const rating = ratingFrom(review.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
    const date = typeof review.created_at === 'string' ? review.created_at : typeof review.date === 'string' ? review.date : '';
    const pictures = Array.isArray(review.pictures) ? review.pictures : [];
    return { id: String(review.id || ''), productHandle, rating,
      customer: String(review.reviewer_name || review.reviewer?.name || ''),
      verified: review.verified === true || review.verified_buyer === true || review.verified_purchase === true,
      date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : '',
      title: typeof review.title === 'string' ? review.title : '',
      body: typeof review.body === 'string' ? review.body : '',
      media: pictures.filter(picture => picture && picture.hidden !== true).map(picture => ({
        type: 'image', url: mediaUrl(picture.url || picture.urls?.original || picture.urls?.large),
        alt: `Customer photo of ${productHandle.toUpperCase()}`
      })) };
  }).filter(Boolean);
  return { reviews, totalPages: payload.total_pages };
}

export function createJudgeMeService({ publicToken, fetchImpl = fetch, timeoutMs = 5000, parseHtml = parseHtmlDefault } = {}) {
  const requests = new Map();
  function request(widget, productId, page = null) {
    const url = judgeMeWidgetUrl({ publicToken, productId, widget, page });
    if (!url) return Promise.resolve(null);
    if (!requests.has(url)) {
      const promise = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(url, { signal: controller.signal, referrerPolicy: 'no-referrer' });
          return response.ok ? await response.json() : null;
        } catch { return null; }
        finally { clearTimeout(timer); }
      })();
      requests.set(url, promise);
    }
    return requests.get(url);
  }
  async function load(products, widgetProductId = null) {
    if (!publicToken) return { status: 'unavailable', products: {} };
    const entries = products.map(product => ({ product, id: shopifyProductId(product.shopifyProductGid) })).filter(entry => entry.id);
    if (!entries.length) return { status: 'unavailable', products: {} };
    const badges = await Promise.all(entries.map(async ({ product, id }) => {
      try { return [product.name.toLowerCase(), parseJudgeMeBadge(await request('preview_badge', id), id, parseHtml) || { status: 'unavailable' }]; }
      catch { return [product.name.toLowerCase(), { status: 'unavailable' }]; }
    }));
    const result = Object.fromEntries(badges);
    const active = entries.find(entry => entry.id === widgetProductId);
    if (active && result[active.product.name.toLowerCase()].status === 'ready') {
      const handle = active.product.name.toLowerCase();
      const summary = result[handle];
      try {
        const widget = parseJudgeMeWidget(await request('product_review', active.id), active.id, summary.count, handle, parseHtml);
        if (widget) {
          summary.distribution = widget.distribution;
          summary.writeReviewUrl = widget.writeReviewUrl;
          summary.reviews = widget.fallbackReviews;
          summary.hasWidget = true;
          if (summary.count) {
            const first = parseJudgeMeReviews(await request('product_review', active.id, 1), active.id, handle);
            if (first) {
              const pages = Math.min(first.totalPages, 20);
              const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, index) => request('product_review', active.id, index + 2)));
              const parsed = rest.map(page => parseJudgeMeReviews(page, active.id, handle));
              if (parsed.every(Boolean)) summary.reviews = [first, ...parsed].flatMap(page => page.reviews);
              else summary.reviews = first.reviews;
              summary.moreAvailable = first.totalPages > pages;
            }
          }
        } else summary.detailUnavailable = true;
      } catch { summary.detailUnavailable = true; }
    }
    return { status: 'ready', products: result };
  }
  return { load };
}
