import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const dir=process.env.ANAWIN_BREAK_IN_EVIDENCE_DIR || '/private/tmp/anawin-break-in-evidence';await mkdir(dir,{recursive:true});
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=9417',`--user-data-dir=${dir}/chrome`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let socket;
const results=[],errors=[],blocked=[];
const startedAt = new Date().toISOString();
await writeFile(`${dir}/results.json`, JSON.stringify({ status: 'running', startedAt }));
try {
  let pages;for(let i=0;i<100;i++){try{pages=await fetch('http://127.0.0.1:9417/json/list').then(r=>r.json());if(pages.length)break}catch{}await sleep(100)}
  assert.ok(pages?.length,'Chrome connection');socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
  let seq=0;const pending=new Map();
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
  socket.onmessage=event=>{const p=JSON.parse(event.data);if(p.id){const t=pending.get(p.id);pending.delete(p.id);p.error?t?.reject(new Error(JSON.stringify(p.error))):t?.resolve(p.result)}
    if(p.method==='Runtime.exceptionThrown')errors.push(p.params.exceptionDetails);
    if(p.method==='Fetch.requestPaused'){const {requestId,request}=p.params;if(!request.url.startsWith('http://127.0.0.1:')){blocked.push(request.url);void call('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'})}else void call('Fetch.continueRequest',{requestId})}
  };
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const until=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await sleep(50)}throw new Error('Timeout: '+expression)};
  const visit=async url=>{await evaluate(`window.__reviewLeaving=true`);await call('Page.navigate',{url});await until(`!window.__reviewLeaving && document.readyState==='complete' && document.querySelector('main')`)};
  const key=async(key,modifiers=0)=>{const code={Enter:13,Tab:9,Escape:27,ArrowDown:40,ArrowRight:39,' ':32}[key];await call('Input.dispatchKeyEvent',{type:'keyDown',key,windowsVirtualKeyCode:code,modifiers,...(key==='Enter'?{text:'\r'}:{})});await call('Input.dispatchKeyEvent',{type:'keyUp',key,windowsVirtualKeyCode:code,modifiers})};
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const radio=async(name,value)=>evaluate(`[...document.querySelectorAll('input[name="${name}"]')].find(input=>input.value===${JSON.stringify(value)}).click()`);
  const close=async()=>{await key('Escape');await until(`!document.body.classList.contains('cart-open')`);await sleep(350)};
  await call('Page.enable');await call('Runtime.enable');await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  for(const width of [1440,375]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===375});
    for(const model of ['mi26','bl50','or17','cm24']) {
      await visit(`http://127.0.0.1:5200/product/${model}`);
      await until(`document.querySelector('.full-size-pdp')`);
      assert.equal(await evaluate(`document.querySelector('.full-size-pdp .add-button').disabled`),true);
      assert.equal(await evaluate(`!!document.querySelector('[data-add]')`),false);
      assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);
    }
    await visit('http://127.0.0.1:5199/');
    await until(`document.querySelector('main')`);await evaluate(`localStorage.clear()`);
    await visit('http://127.0.0.1:5199/product/mi26');
    await until(`document.querySelector('[data-add="full-mint"]') && !document.querySelector('[data-full-size-break-in]').disabled`);
    // Deliberate selections and focused, announced error.
    await click('[data-add]');assert.equal(await evaluate(`document.activeElement.name==='full-size-throw-hand'`),true);
    assert.equal(await evaluate(`document.querySelector('[data-full-size-field-error="full-size-throw-hand"]').textContent`),'Choose an available throw hand.');
    await radio('full-size-throw-hand','Left-Hand Throw (worn on right hand)');
    await evaluate(`document.querySelector('[data-full-size-break-in]').focus()`);await key(' ');
    await until(`!document.querySelector('[data-full-size-customization]').hidden`);
    assert.equal(await evaluate(`document.querySelector('[data-full-size-break-in]').getAttribute('aria-expanded')`),'true');
    await key('Tab');assert.equal(await evaluate(`document.activeElement.name`),'full-size-wearing-style');
    await key('ArrowDown');assert.equal(await evaluate(`!!document.querySelector('[name="full-size-wearing-style"]:checked')`),true);
    await click('[data-add]');assert.equal(await evaluate(`document.querySelector('[data-full-size-field-error="full-size-closure-point"]').textContent`),'Choose where the thumb should meet.');
    await radio('full-size-wearing-style','Other — describe your finger placement');
    await radio('full-size-closure-point','Pinky');await radio('full-size-firmness','Game Ready');
    await click('[data-add]');assert.equal(await evaluate(`document.querySelector('[data-full-size-field-error="full-size-finger-placement"]').textContent`),'Describe your finger placement.');
    const ax = await call('Accessibility.getFullAXTree');
    assert.ok(ax.nodes.some(node => node.role?.value === 'alert'));
    assert.ok(ax.nodes.some(node => node.role?.value === 'radio' && node.name?.value.includes('Other')));
    await evaluate(`document.querySelector('#full-size-finger-placement').value='  custom finger placement  ';document.querySelector('#full-size-finger-placement').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#full-size-break-in-notes').value='<img src=x onerror=alert(1)> soft pocket';document.querySelector('#full-size-break-in-notes').dispatchEvent(new Event('input',{bubbles:true}));`);
    for (const [name, value] of [['full-size-thumb-shape','None'], ['full-size-pinky-shape','Recommend for me'], ['full-size-finger-shape','Recommend for me']]) {
      await click('[data-add]');
      assert.equal(await evaluate(`document.activeElement.name`), name);
      assert.equal(await evaluate(`document.activeElement.getAttribute('aria-invalid')`), 'true');
      assert.ok((await evaluate(`document.activeElement.getAttribute('aria-describedby')`)).includes(name+'-error'));
      assert.equal(await evaluate(`document.querySelector('[data-full-size-field-error="${name}"]').hidden`),false);
      if(name==='full-size-thumb-shape') {
        await key(' '); await key('ArrowDown');
        assert.equal(await evaluate(`document.querySelectorAll('[name="full-size-thumb-shape"]:checked').length`),1);
        assert.equal(await evaluate(`document.querySelectorAll('[name="full-size-pinky-shape"]:checked').length`),0);
      }
      await radio(name, value);
      assert.equal(await evaluate(`document.querySelector('[data-full-size-field-error="${name}"]').hidden`),true);
    }
    await radio('full-size-closure-point','Recommend for me');
    for(const text of ['Thumb shape: None', 'Pinky shape: Recommend for me', 'Finger form: Recommend for me', 'Thumb closure: Recommend for me']) {
      assert.ok((await evaluate(`document.querySelector('[data-full-size-setup-summary]').textContent`)).includes(text));
    }
    await click('[data-full-size-break-in]');
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-full-size-customization] input[type="radio"]')].every(input=>input.disabled&&!input.required&&!input.hasAttribute('aria-invalid'))`),true);
    assert.ok((await evaluate(`document.querySelector('[data-full-size-setup-summary]').textContent`)).includes('No break-in service'));
    await click('[data-full-size-break-in]');
    // Layout and labels; focus-visible with selected field.
    assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-full-size-customization] input, [data-full-size-customization] textarea')].every(input=>input.closest('label')||document.querySelector('label[for="'+input.id+'"]'))`),true);
    const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(`${dir}/form-${width}.png`,Buffer.from(shot.data,'base64'));
    const before=await evaluate(`JSON.parse(localStorage.getItem('anawin-shopify-pending-mutation')||'null')`);assert.equal(before,null);
    await evaluate(`document.querySelector('[data-add]').scrollIntoView({behavior:'instant',block:'center'});document.querySelector('[data-add]').focus();document.querySelector('[data-add]').click();document.querySelector('[data-add]').click()`);
    await until(`document.querySelector('[data-checkout]') && !document.querySelector('[data-checkout]').disabled`);
    assert.equal(await evaluate(`document.querySelectorAll('.cart-item').length`),1);
    const cartAx = await call('Accessibility.getFullAXTree');
    assert.ok(cartAx.nodes.some(node => node.role?.value === 'group' && node.name?.value === 'MI26 break-in instructions'));
    for (const text of ['Glove Model: MI26', 'Throwing Hand: Left']) {
      assert.ok((await evaluate(`document.querySelector('.cart-service-preferences').textContent`)).includes(text));
    }
    assert.ok((await evaluate(`document.querySelector('.cart-body').textContent`)).includes('custom finger placement'));
    assert.ok((await evaluate(`document.querySelector('.cart-body').textContent`)).includes('$75'));
    for(const text of ['Thumb Shape: None', 'Pinky Shape: Recommend for me', 'Finger Form: Recommend for me', 'Thumb Closure: Recommend for me']) assert.ok((await evaluate(`document.querySelector('.cart-body').textContent`)).includes(text));
    assert.equal(await evaluate(`document.querySelectorAll('.cart-service-preferences img').length`),0);
    assert.equal(await evaluate(`document.querySelector('.cart-drawer').scrollWidth>document.querySelector('.cart-drawer').clientWidth`),false);
    assert.equal(await evaluate(`document.querySelector('.quantity span').textContent`),'1');
    await sleep(400);
    assert.equal(await evaluate(`document.querySelector('.cart-drawer').getBoundingClientRect().right<=innerWidth+1`),true);
    const drawerShot=await call('Page.captureScreenshot',{format:'png'});await writeFile(`${dir}/cart-${width}.png`,Buffer.from(drawerShot.data,'base64'));
    await close();assert.equal(await evaluate(`document.activeElement.dataset.add==='full-mint' || document.activeElement.matches('.cart-trigger, .mobile-menu-toggle, main h1')`),true);
    // Different instructions on same variant remain distinct.
    await radio('full-size-thumb-shape','Recommend for me');await radio('full-size-pinky-shape','None');await click('[data-add]');await until(`document.querySelector('[data-checkout]') && !document.querySelector('[data-checkout]').disabled`);
    await close();
    await evaluate(`window.__reviewLeaving=true`);await call('Page.reload');await until(`!window.__reviewLeaving && document.querySelector('[data-add]') && !document.querySelector('[data-full-size-break-in]').disabled`);
    await click('[data-cart]');await until(`document.querySelector('[data-checkout]')`);
    assert.equal(await evaluate(`document.querySelectorAll('.cart-item').length`),2);
    const saved = await evaluate(`[...document.querySelectorAll('.cart-item')].map(item=>item.textContent)`);
    assert.ok(saved[0].includes('Thumb Shape: None') && saved[0].includes('Pinky Shape: Recommend for me'));
    assert.ok(saved[1].includes('Thumb Shape: Recommend for me') && saved[1].includes('Pinky Shape: None'));
    await close();
    results.push({width,productionComingSoonModels:4,shaping:true,conditionalValidation:true,fieldErrors:true,keyboard:true,accessibilityTree:true,errorsAndFocus:true,labels:true,overflow:false,otherRequired:true,doubleSubmit:true,safeText:true,differentInstructions:true,reload:true});
    console.log(`PASS ${width}px production gate, keyboard, labels, validation, cart, double submit, distinct instructions, reload`);
    // Clear session after each width; fixture server retains abandoned mock cart only.
    await evaluate(`localStorage.clear()`);
  }
  assert.deepEqual(errors,[]);
  await writeFile(`${dir}/results.json`,JSON.stringify({status:'passed',startedAt,results,errors,blocked},null,2));
} catch(error) { await writeFile(`${dir}/results.json`, JSON.stringify({status:'failed',startedAt,error:String(error),results,errors,blocked},null,2)); console.error(JSON.stringify({error:String(error),errors,blocked},null,2)); throw error; } finally {socket?.close();chrome.kill()}
