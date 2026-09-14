import './style.css';

const products = [
  { id: 'black', name: 'GLOVE 01', tone: 'Black / Red', price: 150, images: [1,2,3,4].map(n => `/images/black${n}.PNG`) },
  { id: 'blue', name: 'GLOVE 02', tone: 'Blue / Black', price: 150, images: [1,2,3,4].map(n => `/images/blue${n}.PNG`) },
  { id: 'brown', name: 'GLOVE 03', tone: 'Brown / Gold', price: 150, images: [1,2,3,4].map(n => `/images/brown${n}.PNG`) }
];

const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const app = document.querySelector('#app');
let cart = JSON.parse(localStorage.getItem('anawin-cart') || '{}');

function cartCount() { return Object.values(cart).reduce((sum, qty) => sum + qty, 0); }
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
    <div class="product-meta"><div><h3>${product.name}</h3><p>${product.tone} <span class="temporary">Temporary name</span></p></div><strong>${money(product.price)}</strong></div>
  </article>`;
}

function productGrid() { return `<div class="product-grid">${products.map(productCard).join('')}</div>`; }

function home() {
  return `<main>
    <section class="hero">
      <img class="hero-background" src="/images/hero-background.jpg" alt="" />
      <div class="hero-copy"><p class="eyebrow">ANAWIN / 2026</p><h1>BASEBALL<br><em>COMMUNITY</em></h1></div>
      <a href="/shop" data-link class="hero-cta">View all gloves ${arrow()}</a>
    </section>
    <section class="collection"><div class="section-heading"><p class="eyebrow">Collection / 03</p><h2>MINI<br><em>GLOVES</em></h2></div>${productGrid()}</section>
    <section class="statement"><p class="eyebrow">ANAWIN / Baseball gloves</p><div class="statement-mark"><img src="/images/anawin-mark.png" alt="ANAWIN emblem" /></div><a href="/about" data-link>About ANAWIN ${arrow()}</a></section>
  </main>`;
}

function shop() {
  return `<main><section class="page-intro"><p class="eyebrow">Shop / 03 products</p><h1>ALL<br><em>GLOVES.</em></h1><p>Current ANAWIN collection.</p></section><section class="shop-products">${productGrid()}</section></main>`;
}

function productPage(product) {
  if (!product) return notFound();
  return `<main class="pdp"><section class="pdp-gallery">${product.images.map((src,i)=>`<button class="gallery-image" data-image="${src}" aria-label="View image ${i+1}"><img src="${src}" alt="${product.tone} glove view ${i+1}" /></button>`).join('')}</section>
    <aside class="pdp-info"><p class="eyebrow">ANAWIN / Glove 0${products.indexOf(product)+1}</p><h1>${product.name}</h1><p class="tone">${product.tone} <span class="temporary">Temporary name</span></p><p class="price">${money(product.price)}</p>
      <div class="inventory"><span></span>Inventory status coming soon</div>
      <p class="placeholder-copy">Product details, sizing, materials, and specifications will be added when confirmed by ANAWIN.</p>
      <button class="add-button" data-add="${product.id}">Add to cart <span>${money(product.price)}</span></button>
      <details><summary>Product information <span>+</span></summary><p>Final product information has not yet been supplied.</p></details>
      <details><summary>Shipping & returns <span>+</span></summary><p>Shipping and return policies will be published before checkout launches.</p></details>
    </aside></main>`;
}

function about() {
  return `<main><section class="about-hero"><p class="eyebrow">Company / ANAWIN</p><h1>ABOUT<br><em>ANAWIN.</em></h1><div class="about-image"><img src="/images/cherry_pink.png" alt="Cherry-pink ANAWIN glove among flowers" /></div></section>
    <section class="origin"><p class="eyebrow">Company</p><div><h2>OUR STORY</h2><p>Company background and founder story will be added when final copy is available.</p></div></section>
    <section class="founders"><div class="section-heading"><p class="eyebrow">Co-founders / 02</p><h2>CO-<br><em>FOUNDERS.</em></h2></div><div class="founder-grid">${[1,2].map(n=>`<article><div class="founder-placeholder"><span>Founder portrait<br>coming soon</span></div><h3>FOUNDER 0${n}</h3><p class="temporary">Name and biography placeholder</p></article>`).join('')}</div></section>
    <section class="philosophy"><p class="eyebrow">Information</p><h2>MORE DETAILS<br>COMING SOON.</h2><p>Final company and product information will be published here.</p></section></main>`;
}

function notFound() { return `<main class="not-found"><p class="eyebrow">Error / 404</p><h1>PAGE NOT<br><em>FOUND.</em></h1><a href="/" data-link>Return home ${arrow()}</a></main>`; }

function cartDrawer() {
  const items = products.filter(p=>cart[p.id]);
  return `<div class="cart-backdrop" data-close-cart></div><aside class="cart-drawer" aria-label="Shopping cart"><div class="cart-head"><h2>Your cart</h2><button data-close-cart aria-label="Close cart">Close</button></div>
  <div class="cart-body">${items.length ? items.map(p=>`<article class="cart-item"><img src="${p.images[0]}" alt=""><div><h3>${p.name}</h3><p>${p.tone}</p><p>${money(p.price)}</p><div class="quantity"><button data-qty="${p.id}" data-delta="-1" aria-label="Decrease quantity">−</button><span>${cart[p.id]}</span><button data-qty="${p.id}" data-delta="1" aria-label="Increase quantity">+</button></div></div><button class="remove" data-remove="${p.id}">Remove</button></article>`).join('') : `<div class="empty-cart"><p>Your cart is empty.</p><a href="/shop" data-link data-close-cart>Shop gloves ${arrow()}</a></div>`}</div>
  ${items.length ? `<div class="cart-foot"><div><span>Subtotal</span><strong>${money(items.reduce((s,p)=>s+p.price*cart[p.id],0))}</strong></div><p>Taxes and shipping calculated at checkout.</p><button disabled>Checkout coming soon</button><small>Payments remain disabled until secure server-side inventory and order processing are connected.</small></div>` : ''}</aside>`;
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
  document.querySelectorAll('[data-remove]').forEach(el=>el.addEventListener('click',()=>{ delete cart[el.dataset.remove]; saveCart(); refreshCart(); }));
  document.querySelectorAll('[data-qty]').forEach(el=>el.addEventListener('click',()=>{ const id=el.dataset.qty; cart[id]=Math.max(0,Math.min(9,(cart[id]||0)+Number(el.dataset.delta))); if(!cart[id]) delete cart[id]; saveCart(); refreshCart(); }));
}

function bind() {
  document.querySelectorAll('[data-link]').forEach(el=>el.addEventListener('click',e=>{ e.preventDefault(); closeCart(); navigate(el.getAttribute('href')); }));
  document.querySelector('[data-cart]')?.addEventListener('click', openCart);
  document.querySelectorAll('[data-add]').forEach(el=>el.addEventListener('click',()=>{ cart[el.dataset.add]=Math.min(9,(cart[el.dataset.add]||0)+1); saveCart(); openCart(); }));
  document.querySelectorAll('[data-image]').forEach(el=>el.addEventListener('click',()=>{ const overlay=document.createElement('div'); overlay.className='lightbox'; overlay.innerHTML=`<button aria-label="Close image">Close</button><img src="${el.dataset.image}" alt="Expanded product view">`; document.body.append(overlay); overlay.addEventListener('click',()=>overlay.remove()); }));
}

window.addEventListener('popstate', render);
render();
