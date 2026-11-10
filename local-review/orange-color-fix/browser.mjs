import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const here = new URL('./', import.meta.url);

await mkdir(new URL('evidence/', here), { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9295', '--user-data-dir=/private/tmp/anawin-orange-color-fix-chrome',
  '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });
let socket;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let pages;
  for (let i = 0; i < 300; i++) {
    try { pages = await fetch('http://127.0.0.1:9295/json/list').then(r => r.json()); if (pages.length) break; } catch {}
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
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable'); await call('Network.setCacheDisabled',{cacheDisabled:true});
  await call('Page.addScriptToEvaluateOnNewDocument', { source:`window.reviewCLS=0;new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.reviewCLS+=e.value}).observe({type:'layout-shift',buffered:true});` });
  const evidence = [];
  for (const width of [375, 1440]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height:1000, deviceScaleFactor:2, mobile:width===375 });
    for (const model of ['mint', 'black', 'orange', 'camel', 'br16', 'ob16', 'cl16']) {
      const trainer = model.endsWith('16');
      const url = trainer ? `http://127.0.0.1:5197/product/${model}` : `http://127.0.0.1:5197/full-size/${model}`;
      await call('Page.navigate', { url });
      const expectedCount = 4;
      await until(`document.querySelectorAll('.gallery-image').length === ${expectedCount}`);
      // Load and inspect every photograph, including lazy views off screen.
      await evaluate(`(async()=>{for(const b of document.querySelectorAll('.gallery-image')){b.scrollIntoView();await b.querySelector('img').decode()}window.scrollTo(0,0);document.querySelector('.pdp-gallery').scrollLeft=0})()`);
      await sleep(250);
      const dimensions = await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,cls:window.reviewCLS,images:[...document.querySelectorAll('.gallery-image img')].map(i=>({alt:i.alt,source:i.currentSrc,width:i.naturalWidth,height:i.naturalHeight,rendered:i.getBoundingClientRect().width,fit:getComputedStyle(i).objectFit,blend:getComputedStyle(i).mixBlendMode}))})`);
      assert.equal(dimensions.overflow, false, `${model} ${width} page overflow`);
      assert.ok(dimensions.cls < 0.01, `${model} ${width} layout shift ${dimensions.cls}`);
      for (const im of dimensions.images) { assert.ok(im.width > 0 && im.alt);  }
      if (width === 375) {
        await evaluate(`document.querySelectorAll('.gallery-dot')[1].click()`);
        await until(`document.querySelectorAll('.gallery-dot')[1].getAttribute('aria-current') === 'true'`);
        await evaluate(`document.querySelectorAll('.gallery-dot')[0].click()`);
      }
      if (model === 'orange') {
        assert.deepEqual(dimensions.images.map(im => im.source.split('/').pop()), ['orange-back-548.webp','orange-palm-422.webp','orange-side-960.webp','orange-finger-side-567.webp']);
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
      for (let index = 1; index < 4; index++) {
        await key('ArrowRight');
        await until(`document.querySelector('.lightbox-count')?.textContent === '${index+1} of 4' && document.querySelector('.lightbox').getAttribute('aria-busy') === 'false'`);
        if (!trainer) assert.equal(await evaluate(`document.querySelector('.lightbox img').getAttribute('src') === document.querySelectorAll('.gallery-image')[${index}].dataset.image`), true);
      }
      await key('ArrowRight');
      await until(`document.querySelector('.lightbox-count')?.textContent === '1 of 4' && document.querySelector('.lightbox').getAttribute('aria-busy') === 'false'`);
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
      if (trainer) {
        await evaluate(`document.querySelector('.pdp-info [data-add]').click()`);
        await until(`document.body.classList.contains('cart-open') && document.querySelector('.cart-body .cart-item')`);
        assert.equal(await evaluate(`document.querySelector('.cart-drawer').textContent.includes('${model.toUpperCase()}')`),true);
        await key('Escape');
      } else {
        assert.equal(await evaluate(`document.querySelectorAll('[data-add],[data-sticky-add],[data-break-in]').length`),0);
      }
      evidence.push({ model, width, ...dimensions, cart:trainer?'local trainer add PASS':'no purchase controls', keyboard:'PASS', expandedViewer:'PASS', focusReturn:'PASS', pagination:width === 375 ? 'PASS' : 'not shown' });
      console.log(`PASS ${model} ${width}px CLS=${dimensions.cls}`);
    }
  }
  const comparisons = [];
  for (const width of [375,1440]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:2,mobile:width===375});
    await call('Page.navigate',{url:'http://127.0.0.1:5197/local-review/orange-color-fix/compare.html'});
    await until(`document.querySelectorAll('figure img').length===16`);
    await evaluate(`Promise.all([...document.images].map(im=>im.decode()))`);
    const metrics = await evaluate(`(()=>{
      const result=[];
      for(const section of document.querySelectorAll('section')){
        const images=[...section.querySelectorAll('img')];const angle=section.querySelector('h2').textContent;
        if(angle==='side')continue;
        const src=images[0],w=src.naturalWidth,trim=angle==='back'?8:0,h=src.naturalHeight-trim,side=Math.max(w,h),x=Math.floor((side-w)/2),y=Math.floor((side-h)/2);
        function pixels(im,source){const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.fillStyle='white';ctx.fillRect(0,0,w,h);if(source)ctx.drawImage(im,0,trim,w,h,0,0,w,h);else ctx.drawImage(im,x,y,w,h,0,0,w,h);return ctx.getImageData(0,0,w,h).data}
        const reference=pixels(src,true);const errors=images.slice(1).map(im=>{const p=pixels(im,false);let n=0,total=0;for(let i=0;i<p.length;i+=4){const r=reference[i],g=reference[i+1],b=reference[i+2];if(Math.max(r,g,b)-Math.min(r,g,b)<30)continue;for(let c=0;c<3;c++)total+=Math.abs(p[i+c]-reference[i+c]);n+=3}return total/n});
        result.push({angle,before:errors[0],jpeg:errors[1],webp:errors[2]});
      }return result})()`);
    for(const metric of metrics){assert.ok(metric.jpeg<metric.before*0.65,JSON.stringify(metric));assert.ok(metric.webp<metric.before*0.65,JSON.stringify(metric))}
    for(let index=0;index<4;index++){
      await evaluate(`document.querySelectorAll('section')[${index}].scrollIntoView({block:'start'})`);
      await sleep(100);const shot=await call('Page.captureScreenshot',{format:'png'});
      await writeFile(new URL(`evidence/comparison-${index}-${width}.png`,here),Buffer.from(shot.data,'base64'));
    }
    comparisons.push({width,metrics});
    // Confirm cold-cache lower-density displays select smaller variants where available.
    await call('Network.clearBrowserCache');
    await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===375});
    await call('Page.navigate',{url:'http://127.0.0.1:5197/full-size/orange'});
    await until(`document.querySelectorAll('.gallery-image').length===4`);
    await evaluate(`Promise.all([...document.querySelectorAll('.gallery-image img')].map(im=>{im.loading='eager';return im.decode()}))`);
    const selected=await evaluate(`[...document.querySelectorAll('.gallery-image img')].map(im=>im.currentSrc.split('/').pop())`);
    assert.deepEqual(selected,['orange-back-480.webp','orange-palm-422.webp','orange-side-480.webp','orange-finger-side-480.webp']);
    comparisons.at(-1).dpr1Selected=selected;
  }
  await writeFile(new URL('evidence/color-comparisons.json',here),JSON.stringify(comparisons,null,2)+'\n');
  assert.deepEqual(errors, []);
  await writeFile(new URL('evidence/browser-results.json', here), JSON.stringify(evidence, null, 2)+'\n');
  await call('Browser.close');
} finally { socket?.close(); chrome.kill(); }
