import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToken, saveToken } from './token-store.mjs';
import { createEbayInventoryDraft, getInventory, getOrders, getSellerHealth, getNormalizedInventory, getNormalizedOrders } from './ebay-adapter.mjs';
import { scoreOpportunity } from './vetting.mjs';
import { buildDraft, optimizeDraft } from './listing-drafts.mjs';
import { buildHealthReport, deadlineAlerts } from './monitor.mjs';
import { sendApprovalCard } from './telegram-adapter.mjs';
import { scoreMarketSignal } from './market-signals.mjs';
import { rankSuppliers } from './suppliers.mjs';
import { recommendPrice } from './pricing.mjs';
import { profitReport } from './profit-report.mjs';
import { loadState, saveState } from './state-store.mjs';
import { scoreDiscoveredProducts } from './product-discovery.mjs';
import { searchAliExpress } from './aliexpress-adapter.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
try { const envText=await readFile(join(root,'.env'),'utf8'); for(const line of envText.split(/\r?\n/)){const m=line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');} } catch { }
const port = Number(process.env.PORT || 8787);
const mock = process.env.MOCK_MODE !== 'false';

const state = await loadState({
  approvals: [],
  health: { mode: mock ? 'mock' : 'live', liveActionsEnabled: process.env.ENABLE_LIVE_EBAY_ACTIONS === 'true', sellerLevel: 'unknown' },
  adapters: { ebay: 'not connected', aliexpress: 'not connected', suppliers: 'mock catalog', telegram: 'not connected' },
  listingDrafts: [],
  suppliers: [],
  audit: [],
  discovery: {lastRunAt:null,lastCreated:0,lastError:null}
});
const persist=()=>saveState(state).catch(()=>{});
const dashboardSessions=new Set();
function ensureDashboardSession(req,res){const cookies=String(req.headers.cookie||'');const found=cookies.match(/(?:^|;\s*)dashboard_session=([^;]+)/);if(found&&dashboardSessions.has(found[1]))return true;const token=crypto.randomUUID();dashboardSessions.add(token);res.setHeader('Set-Cookie',`dashboard_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);return true;}
const auditEvent=(action,item,result,extra={})=>{state.audit=[...(state.audit||[]),{id:crypto.randomUUID(),action,item,result,at:new Date().toISOString(),...extra}].slice(-500);persist();};

async function runAutomaticDiscovery(){
  if(!process.env.ALIEXPRESS_APP_KEY||!process.env.ALIEXPRESS_APP_SECRET){state.discovery={lastRunAt:new Date().toISOString(),lastCreated:0,lastError:'AliExpress credentials are not configured'};persist();return {ran:false,reason:'AliExpress credentials are not configured',created:0};}
  const categories=['gaming accessories','controller adapter','retro gaming cable']; let created=0,evaluated=0,rejected=0; const errors=[]; let diagnostics=[];
  for(const keywords of categories){
    const result=await searchAliExpress({keywords,deliveryDays:7,pageSize:20}); if(!result.connected){errors.push(`${keywords}: ${result.error||'API unavailable'}`);continue;}
    diagnostics.push({keywords, ...result.diagnostics, total:result.total||0}); const scored=scoreDiscoveredProducts((result.products||[]).map(p=>({...p,marketPrice:p.marketPrice||p.salePrice||39.99,handlingDays:p.handlingDays||3,transitDays:p.transitDays||7})),{targetProfit:10}).map(candidate=>{const supplier=rankSuppliers([{name:candidate.name,cost:candidate.cost,shipping:candidate.shipping,handlingDays:candidate.handlingDays,transitDays:candidate.transitDays,stockConfidence:candidate.stockConfidence,rating:candidate.rating,reviewCount:candidate.reviewCount,trackingReliability:candidate.trackingReliability,returnTerms:candidate.returnTerms,shipFrom:candidate.shipFrom,authorized:candidate.authorized}])[0];return {...candidate,supplierRiskFlags:supplier.riskFlags||[],supplierEligible:supplier.eligible};});
    evaluated+=scored.length; rejected+=scored.filter(x=>x.decision!=='review').length;
    for(const candidate of scored.filter(x=>x.decision==='review').slice(0,5)){
      const duplicate=(state.approvals||[]).some(x=>x.item?.sourceUrl&&x.item.sourceUrl===candidate.url&&x.status!=='rejected'); if(duplicate)continue;
      const draft={id:crypto.randomUUID(),...buildDraft({name:candidate.name,category:candidate.category||keywords,salePrice:candidate.marketPrice,supplierShipping:candidate.shipping||0,shipDays:candidate.transitDays||7,handlingDays:candidate.handlingDays||3,shipFrom:candidate.shipFrom,itemLocation:candidate.shipFrom,photos:candidate.image?[candidate.image]:[],sourceUrl:candidate.url,itemSpecifics:{sourceUrl:candidate.url,source:candidate.source,shipFrom:candidate.shipFrom,estimatedProfit:candidate.estimatedProfit,landedCost:candidate.landedCost,reviewCount:candidate.reviewCount,stockConfidence:candidate.stockConfidence,supplierEligible:candidate.supplierEligible,supplierRiskFlags:candidate.supplierRiskFlags}}),createdAt:new Date().toISOString()}; draft.riskFlags=[...new Set([...(draft.riskFlags||[]),...(candidate.supplierRiskFlags||[])])];
      const optimized=optimizeDraft(draft); state.listingDrafts=[...(state.listingDrafts||[]),optimized]; const approval={id:crypto.randomUUID(),action:'review_listing_draft',item:{draftId:optimized.id,title:optimized.title,profit:candidate.estimatedProfit,landedCost:candidate.landedCost,shippingDays:optimized.estimatedDelivery,origin:optimized.itemLocation,stockConfidence:candidate.stockConfidence,supplierEligible:candidate.supplierEligible,risks:optimized.riskFlags,sourceUrl:candidate.url},status:'pending',createdAt:new Date().toISOString()}; state.approvals.push(approval); auditEvent('Automatic product discovery',candidate.name,'Queued optimized draft for approval',{approvalId:approval.id}); await sendApprovalCard(approval); created++;
    }
  }
  state.discovery={lastRunAt:new Date().toISOString(),lastCreated:created,evaluated,rejected,lastError:errors.length?errors.join(' | '):null,diagnostics};persist(); return {ran:true,created,evaluated,rejected,errors,diagnostics};
}

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
async function finishEbayAuthorization(code) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET || !process.env.TOKEN_ENCRYPTION_KEY) throw new Error('eBay credentials and TOKEN_ENCRYPTION_KEY are required');
  const basic=Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const response=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{authorization:`Basic ${basic}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:process.env.EBAY_REDIRECT_URI})});
  if (!response.ok) throw new Error(`eBay token exchange failed (${response.status})`);
  const token=await response.json(); await saveToken(token); state.adapters.ebay='token stored; read-only mode'; persist();
}

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
    try { await finishEbayAuthorization(url.searchParams.get('code')); }
    catch (error) { return json(res,502,{connected:false,error:error.message}); }
    return json(res,200,{connected:true,message:'eBay authorization stored securely; live mutations remain disabled'});
  }
  if (url.pathname === '/api/ebay/complete' && req.method === 'POST') {
    let raw=''; for await (const chunk of req) raw+=chunk;
    let body; try { body=JSON.parse(raw||'{}'); } catch { return json(res,400,{connected:false,error:'Invalid JSON'}); }
    let code=body.code;
    try { if (!code && body.authorizationUrl) code=new URL(body.authorizationUrl).searchParams.get('code'); } catch { }
    if (!code) return json(res,400,{connected:false,error:'Paste the full eBay authorization-success URL or its code'});
    try { await finishEbayAuthorization(code); return json(res,200,{connected:true,message:'eBay authorization stored securely; live mutations remain disabled'}); }
    catch (error) { return json(res,502,{connected:false,error:error.message}); }
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
    const host=String(req.headers.host||'').split(':')[0].toLowerCase();
    if (!['localhost','127.0.0.1','[::1]'].includes(host)) return json(res,403,{error:'Credential configuration is local-only. Set secrets in the deployment environment.'});
    let raw=''; for await (const chunk of req) raw+=chunk; let body; try { body=JSON.parse(raw||'{}'); } catch { return json(res,400,{error:'Invalid JSON'}); }
    const allowed=['EBAY_CLIENT_ID','EBAY_CLIENT_SECRET','EBAY_REDIRECT_URI','TOKEN_ENCRYPTION_KEY','APPROVAL_SECRET','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'];
    const lines=['PORT=8787',`MOCK_MODE=${mock?'true':'false'}`]; for(const key of allowed) if(typeof body[key]==='string'&&body[key].trim()) lines.push(`${key}=${body[key].trim()}`);
    const fs=await import('node:fs/promises'); await fs.writeFile(join(root,'.env'),lines.join('\n')+'\n','utf8');
    for(const key of allowed) if(typeof body[key]==='string'&&body[key].trim()) process.env[key]=body[key].trim();
    return json(res,200,{saved:true,message:'Saved locally. The connection is ready to authorize.'});
  }
  if (url.pathname === '/api/setup/status' && req.method === 'GET') return json(res,200,{mockMode:mock,integrations:{ebay:{ready:Boolean(process.env.EBAY_CLIENT_ID&&process.env.EBAY_CLIENT_SECRET&&process.env.EBAY_REDIRECT_URI&&process.env.TOKEN_ENCRYPTION_KEY),missing:['EBAY_CLIENT_ID','EBAY_CLIENT_SECRET','EBAY_REDIRECT_URI','TOKEN_ENCRYPTION_KEY'].filter(key=>!process.env[key])},aliexpress:{ready:Boolean(process.env.ALIEXPRESS_APP_KEY&&process.env.ALIEXPRESS_APP_SECRET),missing:['ALIEXPRESS_APP_KEY','ALIEXPRESS_APP_SECRET'].filter(key=>!process.env[key])},telegram:{ready:Boolean(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID),missing:['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'].filter(key=>!process.env[key])},suppliers:{ready:(state.suppliers||[]).length>0,recordCount:(state.suppliers||[]).length}}});
  if (url.pathname === '/api/aliexpress/search' && req.method === 'POST') {
    let raw=''; for await (const chunk of req) raw+=chunk; let body; try { body=JSON.parse(raw||'{}'); } catch { return json(res,400,{connected:false,error:'Invalid JSON',products:[]}); }
    const result=await searchAliExpress(body); if(result.connected) state.adapters.aliexpress='connected; product search read-only'; persist(); return json(res,result.connected?200:503,result);
  }
  if(url.pathname==='/api/discovery/run'&&req.method==='POST')return json(res,200,await runAutomaticDiscovery());
  if (url.pathname === '/api/dashboard' && req.method === 'GET') { ensureDashboardSession(req,res); return json(res,200,{health:state.health,adapters:state.adapters,approvals:state.approvals||[],listingDrafts:state.listingDrafts||[],suppliers:state.suppliers||[],audit:state.audit||[],discovery:state.discovery||null,ebaySnapshot:state.ebaySnapshot||null}); }
  if (url.pathname === '/api/audit' && req.method === 'GET') return json(res,200,state.audit||[]);
  if (url.pathname === '/api/ebay/inventory' && req.method === 'GET') return json(res, 200, await getInventory());
  if (url.pathname === '/api/ebay/orders' && req.method === 'GET') return json(res, 200, await getOrders());
  if (url.pathname === '/api/ebay/inventory/normalized' && req.method === 'GET') return json(res, 200, await getNormalizedInventory());
  if (url.pathname === '/api/ebay/orders/normalized' && req.method === 'GET') return json(res, 200, await getNormalizedOrders());
  if (url.pathname === '/api/ebay/health' && req.method === 'GET') {
    const result=await getSellerHealth();
    if (!result.data) return json(res,result.connected?502:401,result);
    const raw=result.data; const profile=raw.sellerStandardsProfile||raw; const metrics=profile.metrics||profile;
    return json(res,200,{connected:true,raw,report:buildHealthReport({transactionDefectRate:metrics.transactionDefectRate,lateShipmentRate:metrics.lateShipmentRate,trackingValidatedPct:metrics.trackingValidatedPct,casesClosedWithoutResolution:metrics.casesClosedWithoutResolution})});
  }
  const draftSubmitMatch=url.pathname.match(/^\/api\/ebay\/listing-drafts\/([^/]+)\/submit$/);
  if (draftSubmitMatch && req.method === 'POST') {
    let raw=''; for await(const chunk of req) raw+=chunk; let body; try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'});}
    const draft=(state.listingDrafts||[]).find(x=>x.id===draftSubmitMatch[1]); const approval=(state.approvals||[]).find(x=>x.id===body.approvalId);
    if(!draft||!approval)return json(res,404,{error:'Draft or approval not found'});
    if(approval.status!=='approved'||!['review_listing_draft','create_ebay_listing_draft'].includes(approval.action))return json(res,409,{error:'An approved listing-draft approval is required'});
    if(!state.health.liveActionsEnabled)return json(res,403,{error:'Live eBay actions are disabled. Enable the explicit live-actions feature flag before submitting.'});
    const result=await createEbayInventoryDraft(String(body.sku||draft.sku||draft.title).slice(0,50),draft); auditEvent('Submitted eBay listing draft',draft.title,result.error?'Failed':'Submitted',{approvalId:approval.id}); return json(res,result.error?502:200,result);
  }
  if (url.pathname === '/api/sync/ebay' && req.method === 'POST') {
    const [inventory,orders,health]=await Promise.all([getNormalizedInventory(),getNormalizedOrders(),getSellerHealth()]);
    if(!inventory.connected||!orders.connected)return json(res,503,{synced:false,inventory,orders});
    const inventoryRisks=(inventory.items||[]).filter(x=>x.lowStock).map(x=>({type:'low_inventory',sku:x.sku,title:x.title,quantity:x.quantity})); const deadlineRisks=deadlineAlerts(orders.orders||[]); const trackingRisks=(orders.orders||[]).filter(x=>x.status!=='FULFILLED'&&x.trackingStatus==='missing').map(x=>({type:'missing_tracking',orderId:x.orderId}));
    const healthReport=health.data?buildHealthReport(health.data.sellerStandardsProfile?.metrics||health.data):null; if(healthReport?.alerts?.length) for(const alert of healthReport.alerts) state.audit=[...(state.audit||[]),{id:crypto.randomUUID(),action:'Seller health alert',item:'eBay seller standards',result:alert,at:new Date().toISOString()}];
    state.ebaySnapshot={inventory:inventory.items||[],orders:orders.orders||[],health:healthReport,alerts:[...inventoryRisks,...deadlineRisks,...trackingRisks,...(healthReport?.alerts||[]).map(type=>({type:'seller_health',message:type}))],syncedAt:new Date().toISOString()};persist();return json(res,200,{synced:true,syncedAt:state.ebaySnapshot.syncedAt,inventoryCount:state.ebaySnapshot.inventory.length,orderCount:state.ebaySnapshot.orders.length,alertCount:state.ebaySnapshot.alerts.length,healthAvailable:Boolean(healthReport)});
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
    const draft={id:crypto.randomUUID(),...buildDraft(body),createdAt:new Date().toISOString()};state.listingDrafts=[...(state.listingDrafts||[]),draft];auditEvent('Created listing draft',draft.title,'Draft');return json(res,201,draft);
  }
  const draftEditMatch=url.pathname.match(/^\/api\/listing-drafts\/([^/]+)$/);
  if(draftEditMatch && req.method==='PATCH'){
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'});}
    const draft=(state.listingDrafts||[]).find(x=>x.id===draftEditMatch[1]);if(!draft)return json(res,404,{error:'Draft not found'});
    for(const key of ['title','description','category','itemLocation','returnTerms','shipping','handlingDays','estimatedTransitDays','estimatedDelivery','itemSpecifics']) if(body[key]!==undefined) draft[key]=body[key];
    if(Array.isArray(body.photos))draft.photos=body.photos.filter(Boolean).slice(0,12);
    draft.updatedAt=new Date().toISOString();auditEvent('Edited listing draft',draft.title,'Updated',{draftId:draft.id});return json(res,200,draft);
  }
  const draftOptimizeMatch=url.pathname.match(/^\/api\/listing-drafts\/([^/]+)\/optimize$/);
  if(draftOptimizeMatch && req.method==='POST'){
    const index=(state.listingDrafts||[]).findIndex(x=>x.id===draftOptimizeMatch[1]);if(index<0)return json(res,404,{error:'Draft not found'});
    state.listingDrafts[index]=optimizeDraft(state.listingDrafts[index]);auditEvent('Optimized listing draft',state.listingDrafts[index].title,'Updated',{draftId:state.listingDrafts[index].id});return json(res,200,state.listingDrafts[index]);
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
    state.approvals.push(approval); auditEvent('Created approval',body.item?.title||body.item?.name||body.action,'Pending',{approvalId:approval.id}); const notification=await sendApprovalCard(approval); return json(res,201,{...approval,notification});
  }
  const decisionMatch=url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if(decisionMatch && req.method==='POST'){
    const cookies=String(req.headers.cookie||'');const session=cookies.match(/(?:^|;\s*)dashboard_session=([^;]+)/)?.[1];const authorizedSession=session&&dashboardSessions.has(session);if(!authorizedSession&&(!process.env.APPROVAL_SECRET||req.headers['x-approval-secret']!==process.env.APPROVAL_SECRET)) return json(res,401,{error:'Dashboard session required'});
    let raw='';for await(const chunk of req)raw+=chunk;let body;try{body=JSON.parse(raw||'{}')}catch{return json(res,400,{error:'Invalid JSON'})}
    if(!['approved','rejected'].includes(body.decision))return json(res,400,{error:'decision must be approved or rejected'});
    const item=state.approvals.find(x=>x.id===decisionMatch[1]);if(!item)return json(res,404,{error:'Approval not found'});
    item.status=body.decision;item.decidedAt=new Date().toISOString();item.decidedBy=body.decidedBy||'approval-channel';auditEvent('Approval decision',item.item?.title||item.item?.name||item.action,body.decision,{approvalId:item.id,decidedBy:item.decidedBy});
    if(body.decision==='approved'&&item.action==='review_listing_draft'){
      const draft=(state.listingDrafts||[]).find(x=>x.id===item.item?.draftId);
      if(state.health.liveActionsEnabled&&draft){const result=await createEbayInventoryDraft(String(body.sku||draft.sku||draft.title).slice(0,50),draft);auditEvent('Approved eBay listing draft',draft.title,result.error?'Submission failed':'Submitted',{approvalId:item.id});item.execution=result.error?'failed':'submitted';}
      else {item.execution='ready_for_explicit_submission';auditEvent('Approved listing draft',draft?.title||item.action,'Ready; live actions disabled',{approvalId:item.id});}
    }
    persist();return json(res,200,item);
  }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = requested.replaceAll('..','');
  try { const data=await readFile(join(root,safe)); res.writeHead(200,{'content-type':staticTypes[extname(safe)]||'application/octet-stream'}); res.end(data); }
  catch { json(res,404,{error:'Not found'}); }
}

http.createServer((req,res)=>route(req,res).catch(err=>json(res,500,{error:err.message}))).listen(port,()=>{console.log(`Store agent running at http://localhost:${port} (${mock?'mock':'live'} mode)`);if(process.env.ALIEXPRESS_APP_KEY&&process.env.ALIEXPRESS_APP_SECRET){setTimeout(()=>runAutomaticDiscovery().catch(error=>console.error('Automatic discovery failed:',error.message)),15000);setInterval(()=>runAutomaticDiscovery().catch(error=>console.error('Automatic discovery failed:',error.message)),6*60*60*1000);}});
