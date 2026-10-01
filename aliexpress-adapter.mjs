import crypto from 'node:crypto';

const endpoint = process.env.ALIEXPRESS_API_BASE || 'https://eco.taobao.com/router/rest';

function beijingTimestamp(date=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(date);
  const get=type=>parts.find(x=>x.type===type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export function signAliExpress(params, secret) {
  const canonical=Object.keys(params).sort().map(key=>`${key}${params[key]}`).join('');
  return crypto.createHmac('md5',secret).update(canonical).digest('hex').toUpperCase();
}

export function normalizeProduct(product={}) {
  return {
    id:String(product.product_id||''), name:product.product_title||'Untitled product',
    source:'AliExpress API', url:product.product_detail_url||'', image:product.product_main_image_url||'',
    salePrice:Number(product.target_sale_price||product.sale_price||0), cost:Number(product.target_app_sale_price||product.app_sale_price||0),
    rating:Number(String(product.evaluate_rate||'0').replace('%',''))/20, reviewCount:Number(product.lastest_volume||0),
    monthlySales:Number(product.lastest_volume||0), shipFrom:product.ship_from||'', shipping:Number(product.shipping_fee||0),
    transitDays:Number(String(product.ship_to_days||'').match(/\d+/)?.[0]||0), usWarehouse:/united states|^us$/i.test(String(product.ship_from||'')),
    stockConfidence:product.stock_confidence==null?50:Number(product.stock_confidence)
  };
}

export async function searchAliExpress(options={}) {
  const appKey=process.env.ALIEXPRESS_APP_KEY, secret=process.env.ALIEXPRESS_APP_SECRET;
  if(!appKey||!secret) return {connected:false,error:'ALIEXPRESS_APP_KEY and ALIEXPRESS_APP_SECRET are required',products:[]};
  const appSignature=process.env.ALIEXPRESS_APP_SIGNATURE;
  if(!appSignature) return {connected:false,error:'ALIEXPRESS_APP_SIGNATURE is required for the Affiliate API app',products:[],diagnostics:{missing:'ALIEXPRESS_APP_SIGNATURE'}};
  const params={app_key:appKey,format:'json',method:'aliexpress.affiliate.product.query',partner_id:'store-agent',sign_method:'hmac',simplify:'true',timestamp:beijingTimestamp(),v:'2.0',
    fields:'app_sale_price,app_sale_price_currency,commission_rate,evaluate_rate,lastest_volume,product_detail_url,product_id,product_main_image_url,product_title,sale_price,sale_price_currency,ship_to_days,target_app_sale_price,target_sale_price',
    keywords:String(options.keywords||''),page_no:String(Math.max(1,Number(options.pageNo||1))),page_size:String(Math.min(50,Math.max(1,Number(options.pageSize||20)))),platform_product_type:'ALL',sort:'LAST_VOLUME_DESC',target_currency:'USD',target_language:'EN',tracking_id:process.env.ALIEXPRESS_TRACKING_ID||'powerplaygoods',ship_to_country:'US'};
  params.app_signature=appSignature;
  if(options.deliveryDays) params.delivery_days=String(options.deliveryDays);
  if(options.categoryIds) params.category_ids=String(options.categoryIds);
  params.sign=signAliExpress(params,secret);
  let response,text,body;
  try {
    let lastError;
    for(let attempt=0;attempt<3;attempt++) {
      try {
        response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=utf-8'},body:new URLSearchParams(params)});
        break;
      } catch(error) { lastError=error; if(attempt<2) await new Promise(resolve=>setTimeout(resolve,250*(attempt+1))); }
    }
    if(!response) throw lastError||new Error('No response received');
    text=await response.text();
    try{body=JSON.parse(text)}catch{body={raw:text}}
  } catch(error) {
    return {connected:false,error:`AliExpress API request failed: ${error.message}`,products:[],diagnostics:{endpoint}};
  }
  if(!response.ok) return {connected:false,error:`AliExpress API request failed (${response.status})`,products:[],diagnostics:{endpoint,bodyKeys:Object.keys(body||{})}};
  if(body?.error_response) { const apiError=body.error_response; const error=apiError.sub_code==='isv.appkey-not-exists'?'AliExpress rejected the app key. Replace ALIEXPRESS_APP_KEY with the key from the approved app console.':apiError.sub_msg||apiError.msg||'AliExpress rejected the request'; return {connected:false,error,products:[],diagnostics:{bodyKeys:Object.keys(body),errorCode:apiError.code,subCode:apiError.sub_code}}; }
  const root=body?.aliexpress_affiliate_product_query_response?.resp_result||body?.resp_result;
  if(!root) return {connected:false,error:'AliExpress returned an unrecognized response envelope',products:[],diagnostics:{endpoint,bodyKeys:Object.keys(body||{}),responsePreview:String(text||'').slice(0,160)}};
  if(root?.resp_code&&Number(root.resp_code)!==200) return {connected:false,error:root.resp_msg||`AliExpress API error ${root.resp_code}`,products:[],diagnostics:{bodyKeys:Object.keys(body||{}),rootKeys:Object.keys(root||{})}};
  const raw=root?.result?.products?.product||root?.result?.products||root?.result?.product||[];
  return {connected:true,products:Array.isArray(raw)?raw.map(normalizeProduct):[],page:root?.result?.current_page_no||1,total:root?.result?.total_record_count||0,diagnostics:{rootKeys:Object.keys(root||{}),resultKeys:Object.keys(root?.result||{}),productContainer:root?.result?.products==null?'missing':Array.isArray(root.result.products)?'array':typeof root.result.products}};
}
