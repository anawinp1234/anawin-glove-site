import './style.css';

const products = [
  { id: 'black', name: 'BR16', tone: 'Black / Red / Gray', price: 150, images: [1,2,3,4].map(n => `/images/black${n}.PNG`) },
  { id: 'blue', name: 'OB16', tone: 'Sky Blue / Royal / Navy', price: 150, images: [1,2,3,4].map(n => `/images/blue${n}.PNG`) },
  { id: 'brown', name: 'CL16', tone: 'Tan / Brown', price: 150, images: [1,2,3,4].map(n => `/images/brown${n}.PNG`) }
];

const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const breakInPrice = 20;
const app = document.querySelector('#app');
let cart = JSON.parse(localStorage.getItem('anawin-cart') || '{}');

function cartCount() { return products.reduce((sum, product) => sum + (cart[product.id] || 0), 0); }
function saveCart() { localStorage.setItem('anawin-cart', JSON.stringify(cart)); }
function arrow() { return `<span aria-hidden="true">↗</span>`; }

function header() {
  return `<header class="site-header">
    <a class="wordmark" href="/" data-link aria-label="ANAWIN home"><img src="/images/anawin-wordmark.png" alt="ANAWIN" /></a>
    <nav aria-label="Main navigation">
      <a href="/shop" data-link>Shop</a><a href="/about" data-link>About</a>
    </nav>
    <button class="cart-trigger" data-cart aria-label="Open cart with ${cartCount()} items">Cart <span class="cart-count">(${String(cartCount()).padStart(2,'0')})</span></button>
  </header>`;
}

function footer() {
  return `<footer><div class="footer-mark"><img src="/images/anawin-wordmark.png" alt="ANAWIN" /></div><div class="footer-grid">
    <div><p class="eyebrow">Navigation</p><a href="/shop" data-link>Shop</a><a href="/about" data-link>About</a></div>
    <div><p class="eyebrow">Connect</p><a href="mailto:ray@anawinofficial.com">ray@anawinofficial.com</a><a href="https://www.instagram.com/anawinofficial" target="_blank" rel="noreferrer">Instagram — @anawinofficial</a><a href="https://www.tiktok.com/@anawinofficial" target="_blank" rel="noreferrer">TikTok — @anawinofficial</a></div>
    <div><p class="eyebrow">Information</p><span>Shipping — Coming soon</span><span>Returns — Coming soon</span></div>
  </div><div class="legal"><span>© ${new Date().getFullYear()} ANAWIN</span><span>Baseball gloves</span></div></footer>`;
}

function productCard(product, index) {
  return `<article class="product-card reveal" style="--delay:${index * 80}ms">
    <a href="/product/${product.id}" data-link class="product-image">
      <span class="product-index">0${index + 1}</span>
      <img src="${product.images[0]}" alt="${product.tone} ANAWIN glove" loading="${index ? 'lazy' : 'eager'}" />
      <span class="view-product">View ${arrow()}</span>
    </a>
    <div class="product-meta"><div><h3>${product.name}</h3><p>${product.tone}</p></div><strong>${money(product.price)}</strong></div>
  </article>`;
}

function productGrid() { return `<div class="product-grid">${products.map(productCard).join('')}</div>`; }

function home() {
  return `<main>
    <section class="hero">
      <img class="hero-background" src="/images/hero-background.jpg" alt="" />
      <div class="hero-copy"><p class="eyebrow">ANAWIN / 2026</p><h1>COMMUNITY<br><em>BUILT</em></h1></div>
      <a href="/shop" data-link class="hero-cta">View all gloves ${arrow()}</a>
    </section>
    <section class="collection"><div class="section-heading"><p class="eyebrow">Collection / 03</p><h2>MINI<br><em>GLOVES</em></h2></div>${productGrid()}</section>
    <section class="statement"><p class="eyebrow">ANAWIN / Baseball gloves</p><div class="statement-mark"><img src="/images/anawin-mark.png" alt="ANAWIN emblem" /></div><a href="/about" data-link>About ANAWIN ${arrow()}</a></section>
  </main>`;
}

function shop() {
  return `<main><section class="page-intro"><p class="eyebrow">Shop</p><h1>MINI<br><em>GLOVES</em></h1></section><section class="shop-products">${productGrid()}</section></main>`;
}

function productPage(product) {
  if (!product) return notFound();
  return `<main class="pdp"><section class="pdp-gallery">${product.images.map((src,i)=>`<button class="gallery-image" data-image="${src}" aria-label="View image ${i+1}"><img src="${src}" alt="${product.tone} glove view ${i+1}" /></button>`).join('')}</section>
    <aside class="pdp-info"><p class="eyebrow">ANAWIN / ${product.name}</p><h1>${product.name}</h1><p class="tone">${product.tone}</p><p class="price">${money(product.price)}</p>
      <dl class="product-specs"><div><dt>Size</dt><dd>10.25 inches</dd></div><div><dt>Throwing hand</dt><dd>Right-hand throw only</dd></div><div><dt>Leather</dt><dd>US steerhide leather</dd></div><div><dt>Features</dt><dd>Double finger pad</dd></div><div><dt>Thumb</dt><dd>Sheepskin thumb sleeve</dd></div></dl>
      <label class="service-option"><input type="checkbox" data-break-in /><span><strong>Break-in service</strong><small>Optional glove break-in<br>Get your glove ready for practice right away.</small></span><b>+${money(breakInPrice)}</b></label>
      <button class="add-button" data-add="${product.id}">Add to cart <span>${money(product.price)}</span></button>
      <details><summary>Product information <span>+</span></summary><p>Designed for baseball and softball players. Built for faster hands, cleaner transfers, and more consistent defensive work.</p></details>
      <details><summary>Shipping & returns <span>+</span></summary><p>Shipping and return policies will be published before checkout launches.</p></details>
    </aside></main>`;
}

function about() {
  return `<main><section class="about-hero"><p class="eyebrow">Company / ANAWIN</p><h1>ABOUT<br><em>ANAWIN.</em></h1><div class="about-image"><img src="/images/cherry_pink.png" alt="Cherry-pink ANAWIN glove among flowers" /></div></section>
    <section class="origin"><p class="eyebrow">Company</p><div><h2>HOW IT STARTED</h2><p>ANAWIN started with two best friends, over 10 years of friendship, and a shared love for baseball.</p><p>We created ANAWIN with a simple goal: bring more energy and attention back to the game we grew up loving. From the beginning, authenticity has been at the center of what we do. We shared the process, listened to feedback, and let the baseball community help shape what we were building.</p><p>ANAWIN was not just built for the baseball community. It was built with them.</p></div></section>
    <section class="founders"><div class="section-heading"><p class="eyebrow">Co-founders / 02</p><h2>CO-<br><em>FOUNDERS.</em></h2></div><div class="founder-grid">${[1,2].map(n=>`<article><div class="founder-placeholder"><span>Founder portrait<br>coming soon</span></div><h3>FOUNDER 0${n}</h3><p class="temporary">Name and biography placeholder</p></article>`).join('')}</div></section>
    <section class="philosophy"><p class="eyebrow">ANAWIN</p><h2>OUR STORY</h2><div class="story-copy"><p>We met in sixth grade and have been close ever since. Over the years, we have spent countless hours playing catch, throwing sliders into the dirt, talking baseball, and competing over just about everything.</p><p>Baseball has always been part of our friendship, so building ANAWIN felt natural. We wanted to create something that reflected the way we actually grew up around the game: competitive, creative, and authentic.</p><p>What started as an idea between two friends became a brand shaped by the same baseball community we have always been part of.</p></div></section></main>`;
}

function notFound() { return `<main class="not-found"><p class="eyebrow">Error / 404</p><h1>PAGE NOT<br><em>FOUND.</em></h1><a href="/" data-link>Return home ${arrow()}</a></main>`; }

function cartDrawer() {
  const items = products.filter(p=>cart[p.id]);
  return `<div class="cart-backdrop" data-close-cart></div><aside class="cart-drawer" aria-label="Shopping cart"><div class="cart-head"><h2>Your cart</h2><button data-close-cart aria-label="Close cart">Close</button></div>
  <div class="cart-body">${items.length ? items.map(p=>`<article class="cart-item"><img src="${p.images[0]}" alt=""><div><h3>${p.name}</h3><p>${p.tone}</p><p>${money(p.price)}</p>${cart[`breakin-${p.id}`] ? `<p class="cart-service">Break-in service · ${money(breakInPrice)}</p>` : ''}<div class="quantity"><button data-qty="${p.id}" data-delta="-1" aria-label="Decrease quantity">−</button><span>${cart[p.id]}</span><button data-qty="${p.id}" data-delta="1" aria-label="Increase quantity">+</button></div></div><button class="remove" data-remove="${p.id}">Remove</button></article>`).join('') : `<div class="empty-cart"><p>Your cart is empty.</p><a href="/shop" data-link data-close-cart>Shop gloves ${arrow()}</a></div>`}</div>
  ${items.length ? `<div class="cart-foot"><div><span>Subtotal</span><strong>${money(items.reduce((s,p)=>s+(p.price*cart[p.id])+(breakInPrice*(cart[`breakin-${p.id}`]||0)),0))}</strong></div><p>Taxes and shipping calculated at checkout.</p><button disabled>Checkout coming soon</button><small>Payments remain disabled until secure server-side inventory and order processing are connected.</small></div>` : ''}</aside>`;
}

function route() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (path === '/') return home();
  if (path === '/shop') return shop();
  if (path === '/about') return about();
  if (path.startsWith('/product/')) return productPage(products.find(p=>p.id === path.split('/')[2]));
  return notFound();
}

function render() {
  app.innerHTML = header() + route() + footer();
  bind(); window.scrollTo(0,0);
}

function navigate(path) { history.pushState({}, '', path); render(); }
function openCart() { document.body.insertAdjacentHTML('beforeend', cartDrawer()); requestAnimationFrame(()=>document.body.classList.add('cart-open')); bindCart(); }
function closeCart() { document.body.classList.remove('cart-open'); setTimeout(()=>{ document.querySelector('.cart-drawer')?.remove(); document.querySelector('.cart-backdrop')?.remove(); },300); }
function refreshCart() { closeCart(); document.querySelectorAll('.cart-count').forEach(x=>x.textContent=`(${String(cartCount()).padStart(2,'0')})`); setTimeout(openCart,320); }

function bindCart() {
  document.querySelectorAll('[data-close-cart]').forEach(el=>el.addEventListener('click', closeCart));
  document.querySelectorAll('[data-remove]').forEach(el=>el.addEventListener('click',()=>{ delete cart[el.dataset.remove]; delete cart[`breakin-${el.dataset.remove}`]; saveCart(); refreshCart(); }));
  document.querySelectorAll('[data-qty]').forEach(el=>el.addEventListener('click',()=>{ const id=el.dataset.qty; cart[id]=Math.max(0,Math.min(9,(cart[id]||0)+Number(el.dataset.delta))); if (cart[`breakin-${id}`]) cart[`breakin-${id}`]=cart[id]; if(!cart[id]) { delete cart[id]; delete cart[`breakin-${id}`]; } saveCart(); refreshCart(); }));
}

function bind() {
  document.querySelectorAll('[data-link]').forEach(el=>el.addEventListener('click',e=>{ e.preventDefault(); closeCart(); navigate(el.getAttribute('href')); }));
  document.querySelector('[data-cart]')?.addEventListener('click', openCart);
  document.querySelectorAll('[data-add]').forEach(el=>el.addEventListener('click',()=>{ const id=el.dataset.add; cart[id]=Math.min(9,(cart[id]||0)+1); if (document.querySelector('[data-break-in]')?.checked) cart[`breakin-${id}`]=cart[id]; saveCart(); openCart(); }));
  document.querySelectorAll('[data-image]').forEach(el=>el.addEventListener('click',()=>{ const overlay=document.createElement('div'); overlay.className='lightbox'; overlay.innerHTML=`<button aria-label="Close image">Close</button><img src="${el.dataset.image}" alt="Expanded product view">`; document.body.append(overlay); overlay.addEventListener('click',()=>overlay.remove()); }));
}

window.addEventListener('popstate', render);
render();
