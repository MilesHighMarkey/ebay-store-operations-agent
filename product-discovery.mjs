import { recommendPrice } from './pricing.mjs';

// Scores product records supplied by an approved catalog/API/browser source.
// This module deliberately does not scrape, log in, or place supplier orders.
export function scoreDiscoveredProducts(products=[], options={}) {
  const feePct=Number(options.feePct??14), target=Number(options.targetProfit??10);
  return products.map(product=>{
    const sale=Number(product.marketPrice||product.salePrice||0), cost=Number(product.cost||0), shipping=Number(product.shipping||0);
    const fee=sale*feePct/100, profit=sale-fee-cost-shipping, monthly=Number(product.monthlySales||0);
    const rating=Number(product.rating||0), reviews=Number(product.reviewCount||0), stock=Number(product.stockConfidence||0);
    const days=Number(product.handlingDays||99)+Number(product.transitDays||99), us=product.usWarehouse===true||/united states|^us$/i.test(String(product.shipFrom||''));
    const highVolume=monthly>=50&&profit>=5, demand=Math.min(30,monthly*.6)+Math.min(10,Number(product.conversionRate||0)*2);
    const reviewScore=Math.min(15,Math.max(0,rating-3)*5)+(reviews>=100?5:reviews>=20?2:0);
    const score=Math.max(0,profit>=target?25:highVolume?18:profit>0?8:0)+demand+reviewScore+(us?15:0)+(days<=7?15:days<=14?9:days<=21?3:0)+(stock>=80?10:stock>=50?5:0);
    const price=recommendPrice({supplierCost:cost,supplierShipping:shipping,targetProfit:Math.max(target,profit>0?profit:target),marketMedian:sale});
    return {...product,landedCost:Number((cost+shipping).toFixed(2)),estimatedProfit:Number(profit.toFixed(2)),estimatedMonthlyProfit:Number((profit*monthly).toFixed(2)),totalDays:days,usWarehouse:us,highVolumeException:highVolume,preferredTarget:profit>=target,score:Number(score.toFixed(1)),decision:profit>0&&(profit>=target||highVolume)&&stock>=50&&days<=21?'review':'reject',recommendedPrice:price.recommendedPrice};
  }).sort((a,b)=>b.score-a.score);
}
