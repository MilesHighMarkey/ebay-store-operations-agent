import { loadToken } from './token-store.mjs';
import { normalizeInventory, normalizeOrders } from './normalizers.mjs';

const apiBase='https://api.ebay.com';
async function ebayGet(path){
  const token=await loadToken();
  if(!token?.access_token) return {connected:false,error:'No stored eBay access token'};
  const response=await fetch(`${apiBase}${path}`,{headers:{authorization:`Bearer ${token.access_token}`,accept:'application/json'}});
  const body=await response.text(); let data; try{data=JSON.parse(body)}catch{data={raw:body}};
  if(!response.ok) return {connected:true,error:`eBay API returned ${response.status}`,data};
  return {connected:true,data};
}
export const getInventory=()=>ebayGet('/sell/inventory/v1/inventory_item?limit=200');
export const getOrders=()=>ebayGet('/sell/fulfillment/v1/order?limit=100&filter=orderfulfillmentstatus:%7BNOT_STARTED%7CIN_PROGRESS%7D');
export async function getNormalizedInventory(){const result=await getInventory();return result.data?{...result,items:normalizeInventory(result.data)}:result}
export async function getNormalizedOrders(){const result=await getOrders();return result.data?{...result,orders:normalizeOrders(result.data)}:result}
