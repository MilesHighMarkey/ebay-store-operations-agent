export function recommendPrice(input={}){
  const cost=Number(input.supplierCost||0)+Number(input.supplierShipping||0),fee=Number(input.feePct??14)/100,target=Number(input.targetProfit??10),market=Number(input.marketMedian||0),volume=Number(input.monthlySales||0);
  const targetPrice=(cost+target)/(1-fee),volumePrice=(cost+5)/(1-fee),base=market>0?Math.min(targetPrice,market):targetPrice;
  const price=volume>=50&&targetPrice>market&&market>=volumePrice?market:base;
  return {recommendedPrice:Number(price.toFixed(2)),landedCost:Number(cost.toFixed(2)),expectedProfit:Number((price*(1-fee)-cost).toFixed(2)),shippingIncluded:true,reason:price===market?'Market price supports volume exception':market>0?'Competitive price while preserving target':'No market benchmark supplied'};
}
