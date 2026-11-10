import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const here = new URL('./', import.meta.url);

await mkdir(new URL('evidence/', here), { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9294', '--user-data-dir=/private/tmp/anawin-teaser-readiness-chrome',
  '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore' });
let socket;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let pages;
  for (let i = 0; i < 300; i++) {
    try { pages = await fetch('http://127.0.0.1:9294/json/list').then(r => r.json()); if (pages.length) break; } catch {}
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
    const script = expression.startsWith('const ') || expression.startsWith('signupMode=') ? '{' + expression + '}' : expression;
    const r = await call('Runtime.evaluate', { expression:script, awaitPromise:true, returnByValue:true });
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
  if(process.argv.includes('--focus-only')) {
    const focusEvidence=[];
    for(const width of [375,1440]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:2,mobile:width===375});
      for(const model of ['mint','black','camel','orange']) {
        await call('Page.navigate',{url:`http://127.0.0.1:5202/full-size/${model}`});
        await until(`document.querySelector('.pdp-notify input[name=email]') && document.querySelector('body > .newsletter-dialog') && !document.querySelector('.commerce-notice')`);
        await sleep(250);
        await evaluate(`document.querySelector('.pdp-notify input[name=email]').focus()`);
        await key('Tab');await key('Tab',8);
        for(const control of ['email','submit','consent']) {
          await until(`(()=>{const r=document.activeElement.getBoundingClientRect();return r.top>=4&&r.bottom<=innerHeight-4})()`);
          await sleep(250);
          const state=await evaluate(`(()=>{const e=document.activeElement,s=getComputedStyle(e),r=e.getBoundingClientRect();return {name:e.name,type:e.type,visible:e.matches(':focus-visible'),outline:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor,top:r.top,bottom:r.bottom,viewport:innerHeight}})()`);
          assert.equal(state.visible,true);assert.equal(state.outline,'solid');assert.equal(state.width,'2px');assert.ok(state.top>=4&&state.bottom<=state.viewport-4);
          if(control==='email')assert.equal(state.name,'email');if(control==='submit')assert.equal(state.type,'submit');if(control==='consent')assert.equal(state.name,'consent');
          const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(new URL(`evidence/${model}-focused-${control}-${width}.png`,here),Buffer.from(shot.data,'base64'));
          focusEvidence.push({model,width,control,...state});
          if(control!=='consent')await key('Tab');
        }
      }
    }
    await writeFile(new URL('evidence/visible-focus.json',here),JSON.stringify(focusEvidence,null,2)+'\n');
    console.log('PASS: 24 visible-focus checks across all four teaser forms at mobile and desktop widths.');
    await call('Browser.close');socket.close();chrome.kill();process.exit(0);
  }
  await call('Page.addScriptToEvaluateOnNewDocument', { source:`window.reviewCLS=0;new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)window.reviewCLS+=e.value}).observe({type:'layout-shift',buffered:true});` });
  const control = async mode => {
    const status = await evaluate(`fetch('/__review/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'${mode}'})}).then(r=>r.json())`);
    assert.equal(status.mockMode,true);assert.equal(status.realSubmission,false);assert.equal(status.configuredDomain,'anawin-test.myshopify.com');
  };
  const status = () => evaluate(`fetch('/__review/status').then(r=>r.json())`);
  const evidence = [];
  for (const width of [375, 1440]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height:1000, deviceScaleFactor:2, mobile:width===375 });
    for (const model of ['mint', 'black', 'orange', 'camel', 'br16', 'ob16', 'cl16']) {
      const trainer = model.endsWith('16');
      const url = trainer ? `http://127.0.0.1:5202/product/${model}` : `http://127.0.0.1:5202/full-size/${model}`;
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
      let signup = null;
      if (!trainer) {
        assert.equal(await evaluate(`document.querySelectorAll('[data-add],[data-sticky-add],[data-break-in]').length`),0);
        await control('new');
        const labels = await evaluate(`(()=>{const f=document.querySelector('.pdp-notify form');return {email:[...f.elements.email.labels].map(l=>l.textContent).join(''),consent:[...f.elements.consent.labels].map(l=>l.textContent).join(''),description:f.elements.email.getAttribute('aria-describedby'),live:f.querySelector('.newsletter-message').getAttribute('aria-live'),unchecked:!f.elements.consent.checked}})()`);
        assert.equal(labels.email,'Email address');assert.ok(labels.consent.includes('marketing emails'));assert.equal(labels.live,'polite');assert.equal(labels.unchecked,true);
        // Enter the form using real Tab traversal, then activate its button.
        await evaluate(`document.querySelector('.pdp-notify').scrollIntoView({block:'center'});document.querySelector('.pdp-notify input[name=email]').focus()`);
        await key('Tab');assert.equal(await evaluate(`document.activeElement.type`),'submit');
        await key('Tab',8);assert.equal(await evaluate(`document.activeElement.name`),'email');
        const focus = await evaluate(`({visible:document.activeElement.matches(':focus-visible'),width:getComputedStyle(document.activeElement).outlineWidth,style:getComputedStyle(document.activeElement).outlineStyle,color:getComputedStyle(document.activeElement).outlineColor})`);
        assert.equal(focus.visible,true);assert.equal(focus.width,'2px');assert.equal(focus.style,'solid');
        let shot = await call('Page.captureScreenshot',{format:'png'});await writeFile(new URL(`evidence/${model}-focus-${width}.png`,here),Buffer.from(shot.data,'base64'));
        await key('Tab');await key('Enter');
        await until(`document.querySelector('.pdp-notify input[name=email]').getAttribute('aria-invalid')==='true'`);
        assert.equal(await evaluate(`document.activeElement.name`),'email');
        assert.equal(await evaluate(`document.querySelector('.pdp-notify .newsletter-message').getAttribute('role')`),'alert');
        await call('Input.insertText',{text:'invalid'});await key('Tab');await key('Enter');
        await until(`document.querySelector('.pdp-notify .newsletter-message').textContent.includes('valid email')`);
        await evaluate(`const f=document.querySelector('.pdp-notify form');f.elements.email.value='teaser-simulated@example.com';f.elements.email.dispatchEvent(new Event('input',{bubbles:true}))`);
        await key('Tab');await key('Enter');
        await until(`document.querySelector('.pdp-notify input[name=consent]').getAttribute('aria-invalid')==='true'`);
        assert.equal(await evaluate(`document.activeElement.name`),'consent');
        assert.equal((await status()).submissions,0);
        // Toggle explicit consent via keyboard. Shift-Tab reaches submit.
        await call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '});
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
        assert.equal(await evaluate(`document.querySelector('.pdp-notify form').elements.consent.checked`),true);
        await key('Tab',8);assert.equal(await evaluate(`document.activeElement.type`),'submit');
        await control('error');await key('Enter');
        await until(`document.querySelector('.pdp-notify .newsletter-message').textContent.includes('couldn’t')`);
        await control('rate-limit');await evaluate(`document.querySelector('.pdp-notify button[type=submit]').focus()`);await key('Enter');
        await until(`document.querySelector('.pdp-notify .newsletter-message').textContent.includes('Too many')`);
        await control('new');
        await evaluate(`const f=document.querySelector('.pdp-notify form');f.requestSubmit();f.requestSubmit()`);
        await until(`document.querySelector('.pdp-notify .newsletter-fields').hidden`);
        const accepted=await status();
        assert.equal(accepted.submissions,1);assert.equal(accepted.lookups,1);assert.equal(accepted.mutations,1);
        assert.deepEqual(accepted.records,[{marketingState:'SUBSCRIBED',marketingOptInLevel:'SINGLE_OPT_IN',consentTimestampPresent:true}]);
        const ui=await evaluate(`({focus:document.activeElement.tagName,success:!document.querySelector('.pdp-notify .newsletter-success').hidden,message:document.querySelector('.pdp-notify .newsletter-message').getAttribute('role'),heading:document.querySelector('.pdp-notify .newsletter-success h3').textContent,overflow:document.documentElement.scrollWidth>innerWidth})`);
        assert.equal(ui.focus,'H3');assert.equal(ui.success,true);assert.equal(ui.message,'status');assert.equal(ui.heading,'THANK YOU FOR JOINING');assert.equal(ui.overflow,false);
        shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(new URL(`evidence/${model}-success-${width}.png`,here),Buffer.from(shot.data,'base64'));
        signup={labels,focus,validation:'PASS',consent:'PASS',error:'PASS',rateLimit:'PASS',duplicate:'PASS',success:ui,simulatedBackend:accepted};
        if(model==='orange'){
          await control('existing-unsubscribed');
          await call('Page.navigate',{url});await until(`document.querySelector('.pdp-notify form')`);
          await evaluate(`const f=document.querySelector('.pdp-notify form');f.elements.email.value='teaser-simulated@example.com';f.elements.consent.checked=true;f.requestSubmit()`);
          await until(`document.querySelector('.pdp-notify .newsletter-fields').hidden`);
          const existing=await status();assert.equal(existing.mutations,0);assert.equal(existing.existingConsentState,'UNSUBSCRIBED');
          signup.existingConsent=existing;
        }
      } else {
        await evaluate(`document.querySelector('.pdp-info [data-add]').click()`);
        await until(`document.body.classList.contains('cart-open') && document.querySelector('.cart-body .cart-item')`);
        assert.equal(await evaluate(`document.querySelector('.cart-drawer').textContent.includes('${model.toUpperCase()}')`),true);
        await key('Escape');
      }
      evidence.push({ model, width, ...dimensions, signup, cart:trainer?'local trainer add PASS':'no purchase controls', keyboard:'PASS', expandedViewer:'PASS', focusReturn:'PASS', pagination:width === 375 ? 'PASS' : 'not shown' });
      console.log(`PASS ${model} ${width}px CLS=${dimensions.cls}`);
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(new URL('evidence/browser-results.json', here), JSON.stringify(evidence, null, 2)+'\n');
  await call('Browser.close');
} finally { socket?.close(); chrome.kill(); }
