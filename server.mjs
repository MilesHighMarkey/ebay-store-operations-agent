import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToken, saveToken } from './token-store.mjs';
import { getInventory, getOrders, getNormalizedInventory, getNormalizedOrders } from './ebay-adapter.mjs';
import { scoreOpportunity } from './vetting.mjs';
import { buildDraft } from './listing-drafts.mjs';
import { buildHealthReport, deadlineAlerts } from './monitor.mjs';
import { sendApprovalCard } from './telegram-adapter.mjs';
import { scoreMarketSignal } from './market-signals.mjs';
import { rankSuppliers } from './suppliers.mjs';
import { recommendPrice } from './pricing.mjs';
import { profitReport } from './profit-report.mjs';
import { loadState, saveState } from './state-store.mjs';
import { scoreDiscoveredProducts } from './product-discovery.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
try { const envText=await readFile(join(root,'.env'),'utf8'); for(const line of envText.split(/\r?\n/)){const m=line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');} } catch { }
const port = Number(process.env.PORT || 8787);
const mock = process.env.MOCK_MODE !== 'false';

const state = await loadState({
  approvals: [],
  health: { mode: mock ? 'mock' : 'live', liveActionsEnabled: false, sellerLevel: 'unknown' },
  adapters: { ebay: 'not connected', aliexpress: 'not connected', suppliers: 'mock catalog', telegram: 'not connected' },
  listingDrafts: [],
  suppliers: []
});
const persist=()=>saveState(state).catch(()=>{});

try { if (await loadToken()) state.adapters.ebay='token stored; read-only mode'; } catch { /* setup status remains disconnected */ }

const ebayScopes = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly'
];

const json = (res, status, body) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); };
const html = (res, status, body) => { res.writeHead(status, {'content-type':'text/html; charset=utf-8'}); res.end(body); };
const staticTypes = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/auth/ebay/start') {
    if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_REDIRECT_URI) return json(res, 503, {connected:false, error:'EBAY_CLIENT_ID and EBAY_REDIRECT_URI are required'});
    const params = new URLSearchParams({client_id:process.env.EBAY_CLIENT_ID, redirect_uri:process.env.EBAY_REDIRECT_URI, response_type:'code', scope:ebayScopes.join(' ')});
    return json(res, 200, {connected:false, authorizationUrl:`https://auth.ebay.com/oauth2/authorize?${params}`});
  }
  if (url.pathname === '/auth/ebay/callback') {
    if (!url.searchParams.get('code')) return json(res, 400, {connected:false, error:'Missing OAuth authorization code'});
    if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET || !process.env.TOKEN_ENCRYPTION_KEY) return json(res, 503, {connected:false, error:'OAuth callback received, but client credentials and TOKEN_ENCRYPTION_KEY are required'});
    const basic=Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
    const response=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{authorization:`Basic ${basic}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:process.env.EBAY_REDIRECT_URI})});
    if (!response.ok) return json(res,502,{connected:false,error:`eBay token exchange failed (${response.status})`});
    const token=await response.json(); await saveToken(token); state.adapters.ebay='token stored; read-only mode';
    return json(res,200,{connected:true,message:'eBay authorization stored securely; live mutations remain disabled'});
  }
  // AliExpress uses this callback during app authorization. Keep the code out of
  // logs and persistent state; the exchange/credential setup is completed later.
  if ((url.pathname === '/api/aliexpress/callback' || url.pathname === '/auth/aliexpress/callback') && req.method === 'GET') {
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code') || url.searchParams.get('auth_code');
    if (error) {
      state.adapters.aliexpress = `authorization error: ${error}`;
      persist();
      return html(res, 400, '<!doctype html><title>AliExpress authorization</title><h1>Authorization was not completed</h1><p>You can close this window and try again.</p>');
    }
    if (!code) return html(res, 400, '<!doctype html><title>AliExpress authorization</title><h1>Missing authorization code</h1><p>No authorization response was received.</p>');
    state.adapters.aliexpress = 'authorization callback received; credentials not stored';
    persist();
    return html(res, 200, '<!doctype html><title>AliExpress authorization</title><h1>AliExpress authorization received</h1><p>You can close this window and return to the Store Operations Agent.</p>');
  }
  if (url.pathname === '/api/status') return json(res, 200, state);
  if (url.pathname === '/api/discovery/score' && req.method === 'POST') {
    let raw=''; for await (const chunk of req) raw+=chunk; let body; try { body=JSON.parse(raw||'{}'); } catch { return json(res,400,{error:'Invalid JSON'}); }
    return json(res,200,{products:scoreDiscoveredProducts(body.products||[],body.options||[])});
  }
  if (url.pathname === '/api/setup/config' && req.method === 'POST') {
    let raw=''; for await (const chunk of req) raw+=chunk; let body; try { body=JSON.parse(raw||'{}'); } catch { return json(res,400,{error:'Invalid JSON'}); }
    const allowed=['EBAY_CLIENT_ID','EBAY_CLIENT_SECRET','EBAY_REDIRECT_URI','TOKEN_ENCRYPTION_KEY','APPROVAL_SECRET','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'];
    const lines=['PORT=8787','MOCK_MODE=true']; for(const key of allowed) if(typeof body[key]==='string'&&body[key].trim()) lines.push(`${key}=${body[key].trim()}`);
    const fs=await import('node:fs/promises'); await fs.writeFile(join(root,'.env'),lines.join('\n')+'\n','utf8');
    for(const key of allowed) if(typeof body[key]==='string'&&body[key].trim()) process.env[key]=body[key].trim();
    return json(res,200,{saved:true,message:'Saved locally. The connection is ready to authorize.'});
  }
  if (url.pathname === '/api/setup/status' && req.method === 'GET') return json(res,200,{mockMode:mock,integrations:{ebay:{ready:Boolean(process.env.EBAY_CLIENT_ID&&process.env.EBAY_CLIENT_SECRET&&process.env.EBAY_REDIRECT_URI&&process.env.TOKEN_ENCRYPTION_KEY),missing:['EBAY_CLIENT_ID','EBAY_CLIENT_SECRET','EBAY_REDIRECT_URI','TOKEN_ENCRYPTION_KEY'].filter(key=>!process.env[key])},telegram:{ready:Boolean(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID),missing:['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'].filter(key=>!process.env[key])},suppliers:{ready:(state.suppliers||[]).length>0,recordCount:(state.suppliers||[]).length}}});
  if (url.pathname === '/api/dashboard' && req.method === 'GET') return json(res,200,{health:state.health,adapters:state.adapters,approvals:state.approvals||[],listingDrafts:state.listingDrafts||[],suppliers:state.suppliers||[],ebaySnapshot:state.ebaySnapshot||null});
  if (url.pathname === '/api/ebay/inventory' && req.method === 'GET') return json(res, 200, await getInventory());
  if (url.pathname === '/api/ebay/orders' && req.method === 'GET') return json(res, 200, await getOrders());
  if (url.pathname === '/api/ebay/inventory/normalized' && req.method === 'GET') return json(res, 200, await getNormalizedInventory());
  if (url.pathname === '/api/ebay/orders/normalized' && req.method === 'GET') return json(res, 200, await getNormalizedOrders());
  if (url.pathname === '/api/sync/ebay' && req.method === 'POST') {
    const [inventory,orders]=await Promise.all([getNormalizedInventory(),getNormalizedOrders()]);
    if(!inventory.connected||!orders.connected)return json(res,503,{synced:false,inventory,orders});
    state.ebaySnapshot={inventory:inventory.items||[],orders:orders.orders||[],syncedAt:new Date().toISOString()};persist();return json(res,200,{synced:true,syncedAt:state.ebaySnapshot.syncedAt,inventoryCount:state.ebaySnapshot.inventory.length,orderCount:state.ebaySnapshot.orders.length});
  }
  if (url.pathname === '/api/opportunities/score' && req.method === 'POST') {
    let raw=''; for await (const chunk of req) raw+=chunk;
    let body; try { body=JSON.parse(raw||'{}'); } catch { return json(res,400,{error:'Invalid JSON'}); }
    return json(res,200,scoreOpportunity(body));
  }
  if (url.pathname === '/api/market/signals' && req.method === 'POST') {
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})};return json(res,200,scoreMarketSignal(body));
  }
  if (url.pathname === '/api/suppliers/rank' && req.method === 'POST') {
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})};return json(res,200,{suppliers:rankSuppliers(body.suppliers||[])});
  }
  if (url.pathname === '/api/suppliers/catalog' && req.method === 'GET') return json(res,200,state.suppliers||[]);
  if (url.pathname === '/api/suppliers/catalog' && req.method === 'POST') {
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})};
    if(!Array.isArray(body.suppliers))return json(res,400,{error:'suppliers must be an array'});
    state.suppliers=body.suppliers.map(s=>({...s,id:s.id||crypto.randomUUID(),importedAt:new Date().toISOString(),source:s.source||'user-import'}));persist();return json(res,201,{count:state.suppliers.length,suppliers:state.suppliers});
  }
  if (url.pathname === '/api/pricing/recommend' && req.method === 'POST') {
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})};return json(res,200,recommendPrice(body));
  }
  if (url.pathname === '/api/profit/report' && req.method === 'POST') {
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})};return json(res,200,profitReport(body.orders||[],body.costs||{},body.feePct??14));
  }
  if (url.pathname === '/api/listing-drafts' && req.method === 'GET') return json(res,200,state.listingDrafts||[]);
  if (url.pathname === '/api/listing-drafts' && req.method === 'POST') {
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})}
    const draft={id:crypto.randomUUID(),...buildDraft(body),createdAt:new Date().toISOString()};state.listingDrafts=[...(state.listingDrafts||[]),draft];persist();return json(res,201,draft);
  }
  if (url.pathname === '/api/monitor/health' && req.method === 'POST') {
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})};return json(res,200,buildHealthReport(body));
  }
  if (url.pathname === '/api/monitor/deadlines' && req.method === 'POST') {
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})};return json(res,200,{alerts:deadlineAlerts(body.orders||[],body.now?new Date(body.now):new Date())});
  }
  if (url.pathname === '/api/approvals' && req.method === 'GET') return json(res, 200, state.approvals);
  if (url.pathname === '/api/approvals' && req.method === 'POST') {
    let raw=''; for await (const chunk of req) raw += chunk;
    let body={}; try { body=JSON.parse(raw||'{}'); } catch { return json(res,400,{error:'Invalid JSON'}); }
    if (!body.action || !body.item) return json(res,400,{error:'action and item are required'});
    const approval={id:crypto.randomUUID(), action:body.action, item:body.item, status:'pending', createdAt:new Date().toISOString()};
    state.approvals.push(approval); persist(); const notification=await sendApprovalCard(approval); return json(res,201,{...approval,notification});
  }
  const decisionMatch=url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if(decisionMatch && req.method==='POST'){
    if(!process.env.APPROVAL_SECRET || req.headers['x-approval-secret']!==process.env.APPROVAL_SECRET) return json(res,401,{error:'Approval secret required'});
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})}
    if(!['approved','rejected'].includes(body.decision))return json(res,400,{error:'decision must be approved or rejected'});
    const item=state.approvals.find(x=>x.id===decisionMatch[1]);if(!item)return json(res,404,{error:'Approval not found'});
    item.status=body.decision;item.decidedAt=new Date().toISOString();item.decidedBy=body.decidedBy||'approval-channel';persist();return json(res,200,item);
  }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = requested.replaceAll('..','');
  try { const data=await readFile(join(root,safe)); res.writeHead(200,{'content-type':staticTypes[extname(safe)]||'application/octet-stream'}); res.end(data); }
  catch { json(res,404,{error:'Not found'}); }
}

http.createServer((req,res)=>route(req,res).catch(err=>json(res,500,{error:err.message}))).listen(port,()=>console.log(`Store agent running at http://localhost:${port} (${mock?'mock':'live'} mode)`));
