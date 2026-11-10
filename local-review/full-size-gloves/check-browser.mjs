import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const here = new URL('./', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', here), 'utf8'));
await mkdir(new URL('evidence/', here), { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9296', '--user-data-dir=/private/tmp/anawin-full-size-review-chrome',
  '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });
let socket;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let pages;
  for (let i = 0; i < 300; i++) {
    try { pages = await fetch('http://127.0.0.1:9296/json/list').then(r => r.json()); if (pages.length) break; } catch {}
    await sleep(100);
  }
  assert.ok(pages?.length, 'Chrome debugging connection');
  socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.id) { const task = pending.get(value.id); pending.delete(value.id); value.error ? task.reject(new Error(JSON.stringify(value.error))) : task.resolve(value.result); }
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.text);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id:n, method, params })); });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const until = async expression => { for (let i=0; i<100; i++) { if (await evaluate(expression)) return; await sleep(50); } throw new Error('Timed out: ' + expression); };
  const key = async (key, modifiers = 0) => {
    const codes = { Enter:13, Escape:27, ArrowLeft:37, ArrowRight:39, Tab:9 };
    await call('Input.dispatchKeyEvent', { type:'keyDown', key, code:key, windowsVirtualKeyCode:codes[key], modifiers, ...(key === 'Enter' ? { text:'\r' } : {}) });
    await call('Input.dispatchKeyEvent', { type:'keyUp', key, code:key, windowsVirtualKeyCode:codes[key], modifiers });
  };
  await call('Page.enable'); await call('Runtime.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source:`window.reviewCLS=0;new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.reviewCLS+=e.value}).observe({type:'layout-shift',buffered:true});` });
  const evidence = [];
  for (const width of [375, 768, 1440]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height:1000, deviceScaleFactor:2, mobile:width===375 });
    for (const model of ['mint', 'black', 'orange', 'camel', 'br16', 'ob16', 'cl16']) {
      const trainer = model.endsWith('16');
      const url = trainer ? `http://127.0.0.1:5197/product/${model}` : `http://127.0.0.1:5196/${model}`;
      await call('Page.navigate', { url });
      const expectedCount = trainer ? 4 : manifest.filter(e => e.model === model && e.usable).length;
      await until(`document.querySelectorAll('.gallery-image').length === ${expectedCount}`);
      // Load and inspect every photograph, including lazy views off screen.
      await evaluate(`(async()=>{for(const b of document.querySelectorAll('.gallery-image')){b.scrollIntoView();await b.querySelector('img').decode()}window.scrollTo(0,0);document.querySelector('.pdp-gallery').scrollLeft=0})()`);
      await sleep(250);
      const dimensions = await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,cls:window.reviewCLS,images:[...document.querySelectorAll('.gallery-image img')].map(i=>({alt:i.alt,source:i.currentSrc,width:i.naturalWidth,height:i.naturalHeight,rendered:i.getBoundingClientRect().width,fit:getComputedStyle(i).objectFit,blend:getComputedStyle(i).mixBlendMode}))})`);
      assert.equal(dimensions.overflow, false, `${model} ${width} page overflow`);
      assert.ok(dimensions.cls < 0.01, `${model} ${width} layout shift ${dimensions.cls}`);
      for (const im of dimensions.images) { assert.ok(im.width > 0 && im.alt); if (!trainer) assert.equal(im.blend, 'normal'); }
      if (width === 375) {
        await evaluate(`document.querySelectorAll('.gallery-dot')[1].click()`);
        await until(`document.querySelectorAll('.gallery-dot')[1].getAttribute('aria-current') === 'true'`);
        await evaluate(`document.querySelectorAll('.gallery-dot')[0].click()`);
      }
      // Native keyboard activation, arrow wrap, focus trap, and focus return.
      await evaluate(`window.scrollTo(0,0);document.querySelector('.gallery-image').focus()`);
      await key('Enter');
      await until(`document.querySelector('.lightbox')?.getAttribute('aria-busy') === 'false'`);
      assert.equal(await evaluate(`document.querySelector('.lightbox-count').textContent`), `1 of ${dimensions.images.length}`);
      await key('ArrowLeft');
      await until(`document.querySelector('.lightbox-count')?.textContent === '${dimensions.images.length} of ${dimensions.images.length}' && document.querySelector('.lightbox').getAttribute('aria-busy') === 'false'`);
      assert.equal(await evaluate(`document.querySelector('.lightbox img').hidden`), false);
      await key('ArrowRight');
      await until(`document.querySelector('.lightbox-count')?.textContent === '1 of ${dimensions.images.length}' && document.querySelector('.lightbox').getAttribute('aria-busy') === 'false'`);
      await evaluate(`document.querySelector('.lightbox-close').focus()`);
      await key('Tab', 8);
      assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Next image');
      await key('Tab');
      assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), 'Close image');
      if (!trainer && width === 1440) {
        const shot = await call('Page.captureScreenshot', { format:'png' });
        await writeFile(new URL(`evidence/${model}-zoom.png`, here), Buffer.from(shot.data, 'base64'));
      }
      await key('Escape');
      assert.equal(await evaluate(`!!document.querySelector('.lightbox')`), false);
      assert.equal(await evaluate(`document.activeElement === document.querySelector('.gallery-image')`), true);
      await evaluate(`document.activeElement.blur();window.scrollTo(0,0)`);
      if (!trainer && width !== 768) {
        const shot = await call('Page.captureScreenshot', { format:'png' });
        await writeFile(new URL(`evidence/${model}-${width}.png`, here), Buffer.from(shot.data, 'base64'));
      }
      evidence.push({ model, width, ...dimensions, keyboard:'PASS', expandedViewer:'PASS', focusReturn:'PASS', pagination:width === 375 ? 'PASS' : 'not shown' });
      console.log(`PASS ${model} ${width}px CLS=${dimensions.cls}`);
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(new URL('evidence/browser-results.json', here), JSON.stringify(evidence, null, 2)+'\n');
  await call('Browser.close');
} finally { socket?.close(); chrome.kill(); }
