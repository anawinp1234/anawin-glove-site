// Local browser -> actual Worker entry -> simulated Shopify. Never real signup.
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import worker from '../../worker/index.js';

const origin = 'http://127.0.0.1:5202';
const domain = 'anawin-test.myshopify.com';
const dist = new URL('../../dist/', import.meta.url);
const files = new Map();
async function index(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    if (entry.isDirectory()) await index(new URL(entry.name+'/', directory), prefix+entry.name+'/');
    else files.set('/'+prefix+entry.name, new URL(entry.name, directory));
  }
}
await index(dist);
let mode = 'new', lookups = 0, mutations = 0, submissions = 0, records = new Map();
const summary = () => ({ mockMode:true, realSubmission:false, configuredDomain:domain, mode, lookups, mutations, submissions,
  existingConsentState:mode === 'existing-unsubscribed' ? 'UNSUBSCRIBED' : null,
  records:[...records.values()].map(record => ({ marketingState:record.emailMarketingConsent.marketingState,
    marketingOptInLevel:record.emailMarketingConsent.marketingOptInLevel,
    consentTimestampPresent:!Number.isNaN(Date.parse(record.emailMarketingConsent.consentUpdatedAt)) })) });
const customer = (email, state) => ({ id:'gid://shopify/Customer/1',defaultEmailAddress:{emailAddress:email,marketingState:state} });
// A closed outbound boundary: the Worker cannot contact Shopify or other hosts.
globalThis.fetch = async (url, options) => {
  if (url !== `https://${domain}/admin/api/2026-07/graphql.json`) throw new Error('Unexpected simulated upstream');
  const body = JSON.parse(options.body);
  await new Promise(resolve => setTimeout(resolve, 100));
  if (mode === 'error') return Response.json({ error:'simulated' }, {status:503});
  if (body.query.includes('query NewsletterCustomer(')) {
    lookups++;
    const email = /email:"([^"]+)"/.exec(body.variables.query)?.[1];
    const record = records.get(email);
    const nodes = mode === 'existing-unsubscribed' ? [customer(email,'UNSUBSCRIBED')]
      : record ? [customer(email,record.emailMarketingConsent.marketingState)] : [];
    return Response.json({data:{customers:{nodes}}});
  }
  if (body.query.includes('mutation NewsletterCustomerCreate(')) {
    mutations++;
    if (mode !== 'new') throw new Error('Unexpected simulated mutation');
    const record = body.variables.input;
    if (record.emailMarketingConsent?.marketingState !== 'SUBSCRIBED' || record.emailMarketingConsent?.marketingOptInLevel !== 'SINGLE_OPT_IN') throw new Error('Unexpected simulated consent');
    records.set(record.email,record);
    return Response.json({data:{customerCreate:{customer:customer(record.email,'SUBSCRIBED'),userErrors:[]}}});
  }
  throw new Error('Unexpected simulated operation');
};
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.xml':'application/xml'};
const env = {
  SHOPIFY_STORE_DOMAIN:domain,SHOPIFY_ADMIN_API_VERSION:'2026-07',NEWSLETTER_OPT_IN_MODE:'single',
  SHOPIFY_ADMIN_ACCESS_TOKEN:'simulation-only-not-a-credential',
  NEWSLETTER_IP_LIMITER:{limit:async()=>({success:mode !== 'rate-limit'})},
  NEWSLETTER_EMAIL_LIMITER:{limit:async()=>({success:true})},
  ASSETS:{fetch:async request=>{
    const path = new URL(request.url).pathname;
    const file = files.get(path === '/' ? '/index.html' : path) || files.get(path+'.html');
    if (!file) return new Response('Not found',{status:404});
    const extension = /\.[^.]+$/.exec(fileURLToPath(file))?.[0];
    return new Response(await readFile(file),{headers:{'Content-Type':types[extension]||'application/octet-stream'}});
  }}
};
http.createServer(async(req,res)=>{
  try {
    if (req.headers.host !== '127.0.0.1:5202') {res.writeHead(403);res.end();return;}
    const url = new URL(req.url,origin);
    if (url.pathname === '/__review/control' && req.method === 'POST') {
      let text='';for await(const chunk of req)text+=chunk;
      const value=JSON.parse(text);
      if (!['new','existing-unsubscribed','error','rate-limit'].includes(value.mode)) throw new Error('Invalid simulation mode');
      mode=value.mode;lookups=0;mutations=0;submissions=0;records=new Map();
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(summary()));return;
    }
    if (url.pathname === '/__review/status') {
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(summary()));return;
    }
    let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)throw new Error('Body limit');}
    if (url.pathname === '/api/newsletter') submissions++;
    const request = new Request(url,{method:req.method,headers:req.headers,...(body?{body}:{})});
    const response = await worker.fetch(request,env);
    res.writeHead(response.status,{...Object.fromEntries(response.headers),'Cache-Control':'no-store','X-Review-Mode':'SIMULATED','X-Robots-Tag':'noindex, nofollow',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"});
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {res.writeHead(500);res.end('Local simulation failed');}
}).listen(5202,'127.0.0.1',()=>console.log(origin+' — SIMULATED Shopify only; no real submission'));
