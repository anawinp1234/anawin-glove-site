// Cart break-in button regression: layout, hit targets, enlarged text and editor focus for BR16 in the cart.
// Independent of the full-size PDP rehearsal in break-in-browser.mjs. Uses the loopback-only fixture server
// (started here if it is not already running); no Shopify requests or real carts are used.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dir=process.env.ANAWIN_CART_EVIDENCE_DIR || join(tmpdir(),'anawin-cart-break-in-evidence');await mkdir(dir,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const up=()=>fetch('http://127.0.0.1:5199/').then(r=>r.ok,()=>false);
const server=await up()?null:spawn(process.execPath,[new URL('./break-in-server.mjs',import.meta.url).pathname],{stdio:'ignore'});
// ANAWIN_CHROME overrides the macOS Chrome path, e.g. a Linux Chrome binary.
const chrome=spawn(process.env.ANAWIN_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=9418',`--user-data-dir=${dir}/chrome`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
let socket;const results=[],errors=[],blocked=[];
const startedAt=new Date().toISOString();
await writeFile(`${dir}/results.json`,JSON.stringify({status:'running',startedAt}));
try {
  for(let i=0;i<200&&!await up();i++)await sleep(100);
  assert.ok(await up(),'Fixture server on 127.0.0.1:5199');
  let pages;for(let i=0;i<100;i++){try{pages=await fetch('http://127.0.0.1:9418/json/list').then(r=>r.json());if(pages.length)break}catch{}await sleep(100)}
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
  const key=async key=>{const code={Enter:13,Escape:27}[key];await call('Input.dispatchKeyEvent',{type:'keyDown',key,windowsVirtualKeyCode:code,...(key==='Enter'?{text:'\r'}:{})});await call('Input.dispatchKeyEvent',{type:'keyUp',key,windowsVirtualKeyCode:code})};
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const close=async()=>{await key('Escape');await until(`!document.body.classList.contains('cart-open')`);await sleep(350)};
  await call('Page.enable');await call('Runtime.enable');await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});

  // Geometry of one control: size, row/column alignment, wrapping, clipping, whether its left and right edges
  // receive clicks, and any other control in the row whose box it overlaps.
  const box=selector=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',behavior:'instant'});
    const r=e.getBoundingClientRect(),d=document.querySelector('.cart-drawer').getBoundingClientRect(),item=e.closest('.cart-item').getBoundingClientRect(),info=e.closest('.cart-item-info').getBoundingClientRect(),t=document.createRange();t.selectNodeContents(e);
    const hits=el=>{const b=el.getBoundingClientRect();return [b.left+3,b.right-3].every(x=>{const h=document.elementFromPoint(Math.min(x,d.right-1),b.top+b.height/2);return !!h&&(h===el||el.contains(h))})};
    const others=[...e.closest('.cart-item').querySelectorAll('button,a,input')].filter(o=>{if(o===e)return false;const b=o.getBoundingClientRect();return b.left<r.right&&b.right>r.left&&b.top<r.bottom&&b.bottom>r.top}).map(o=>o.outerHTML.slice(0,60));
    return {width:r.width,height:r.height,inside:r.left>=d.left-0.5&&r.right<=d.right+0.5,lines:Math.round(t.getBoundingClientRect().height/parseFloat(getComputedStyle(e).lineHeight)),clipped:e.scrollWidth>e.clientWidth+1,
      clickable:hits(e),blockedOthers:others,rowAligned:Math.abs(r.left-item.left)<=1&&Math.abs(r.right-item.right)<=1,inColumn:r.left>=info.left-0.5&&r.right<=info.right+0.5}})()`);
  const drawerOverflow=()=>evaluate(`(()=>{const d=document.querySelector('.cart-drawer'),b=document.querySelector('.cart-body');return d.scrollWidth>d.clientWidth||b.scrollWidth>b.clientWidth||document.documentElement.scrollWidth>innerWidth})()`);
  const checkButtons=async(width,label,selectors)=>{
    assert.equal(await drawerOverflow(),false,`${label} ${width}px drawer overflow`);
    for(const selector of selectors){const b=await box(selector),where=`${label} ${width}px ${selector} ${JSON.stringify(b)}`;
      assert.ok(b.width>=44&&b.height>=44,`${where} hit target`);
      assert.ok(b.inside&&!b.clipped&&b.clickable,`${where} inside, unclipped, clickable edges`);
      assert.deepEqual(b.blockedOthers,[],`${where} overlaps another control`);
      // Below 375px every break-in control spans the whole cart row on one line. At 375px and wider it stays in
      // the details column, where labels may wrap by design.
      if(width<375){assert.ok(b.rowAligned,`${where} spans the cart row`);assert.equal(b.lines,1,`${where} wraps at default text size`)}
      else assert.ok(b.inColumn,`${where} stays in the details column`);}
    // 200% text: labels may wrap but must stay inside the drawer, unclipped, clickable and at least 44px.
    await evaluate(`document.head.insertAdjacentHTML('beforeend','<style id="review-large-text">.cart-service-button{font-size:22px!important}.cart-item p{font-size:24px!important}</style>')`);
    assert.equal(await drawerOverflow(),false,`${label} ${width}px drawer overflow with enlarged text`);
    for(const selector of selectors){const b=await box(selector);assert.ok(b.width>=44&&b.height>=44&&b.inside&&!b.clipped&&b.clickable&&!b.blockedOthers.length,`${label} ${width}px ${selector} enlarged ${JSON.stringify(b)}`)}
    await evaluate(`document.getElementById('review-large-text').remove()`);
  };
  const focusRoundTrip=async(trigger,label,width)=>{
    await evaluate(`document.querySelector(${JSON.stringify(trigger)}).focus()`);await key('Enter');
    await until(`document.activeElement?.closest('[data-service-form]')`);
    await evaluate(`document.querySelector('[data-cancel-service]').focus()`);await key('Enter');
    await until(`!document.querySelector('[data-service-form]')`);
    assert.equal(await evaluate(`document.activeElement.matches(${JSON.stringify(trigger)})`),true,`${label} ${width}px cancel restores focus`);
  };
  const add='[data-add-service]',edit='[data-edit-service]',remove='[data-remove-service]';
  const ready=selector=>until(`document.querySelector('${selector}') && !document.querySelector('${selector}').disabled`);
  const quantity=async(delta,expected,selector)=>{await click(`[data-qty-line][data-delta="${delta}"]`);await until(`document.querySelector('.quantity span')?.textContent==='${expected}'`);await ready(selector)};
  const shot=async name=>{const s=await call('Page.captureScreenshot',{format:'png'});await writeFile(`${dir}/${name}.png`,Buffer.from(s.data,'base64'))};
  for(const width of [1440,375,320]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<1000});
    await visit('http://127.0.0.1:5199/');await evaluate(`localStorage.clear();localStorage.setItem('anawin-newsletter-popup','{"subscribed":true}')`);
    await visit('http://127.0.0.1:5199/product/br16');
    await until(`document.querySelector('[data-add="black"]') && !document.querySelector('[data-add="black"]').disabled`);
    await click('[data-add="black"]');await ready(add);await sleep(400);
    // Unserviced BR16, quantity 1: Add, editor focus in and back out.
    await checkButtons(width,'no break-in qty 1',[add]);
    await focusRoundTrip(add,'add',width);
    await shot(`cart-no-break-in-${width}`);
    // Unserviced BR16, quantity 2: Add break-in to 1.
    await quantity(1,'2',add);
    assert.match(await evaluate(`document.querySelector('${add}').textContent`),/^Add break-in to 1/);
    await checkButtons(width,'no break-in qty 2',[add]);
    await quantity(-1,'1',add);
    // Add break-in through the cart editor.
    await click(add);await ready('[data-confirm-service]');await click('[data-confirm-service]');await ready(remove);
    // Serviced BR16, quantity 1: Edit and Remove, editor focus in and back out.
    await checkButtons(width,'break-in qty 1',[edit,remove]);
    await focusRoundTrip(edit,'edit',width);
    await shot(`cart-break-in-${width}`);
    // Serviced BR16, quantity 2.
    await quantity(1,'2',edit);
    assert.equal(await evaluate(`document.querySelector('${edit}').textContent`),'Edit break-in for 1');
    await checkButtons(width,'break-in qty 2',[edit,remove]);
    await shot(`cart-break-in-qty2-${width}`);
    // Remove break-in.
    await quantity(-1,'1',remove);
    await click(remove);await until(`document.querySelector('${add}') && !document.querySelector('${remove}')`);
    results.push({width,unservicedQty1:true,unservicedQty2:true,servicedQty1:true,servicedQty2:true,add:true,edit:true,remove:true,editorFocus:true,enlargedText:true,overflow:false});
    console.log(`PASS ${width}px cart break-in: add/edit/remove, qty 1 and 2, 44px targets, clickable edges, enlarged text, editor focus, no overflow`);
    await close();await evaluate(`localStorage.clear()`);
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(blocked,[]);
  await writeFile(`${dir}/results.json`,JSON.stringify({status:'passed',startedAt,results,errors,blocked},null,2));
} catch(error) { await writeFile(`${dir}/results.json`,JSON.stringify({status:'failed',startedAt,error:String(error),results,errors,blocked},null,2)); console.error(JSON.stringify({error:String(error),errors,blocked},null,2)); process.exitCode=1; } finally {socket?.close();chrome.kill();server?.kill()}
