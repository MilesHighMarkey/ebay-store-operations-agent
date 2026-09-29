export function scoreOpportunity(input={}) {
  const sale=Number(input.salePrice||0), cost=Number(input.supplierCost||0), shipping=Number(input.supplierShipping||0);
  const fee=Number(input.feePct ?? 14)/100, sales=Number(input.monthlySales||0);
  const profit=sale-(sale*fee)-cost-shipping, monthly=profit*sales;
  const shipDays=Number(input.shipDays||99), handlingDays=Number(input.handlingDays||99), stock=Number(input.stockConfidence??0), competition=Number(input.competitionScore??50);
  let score=0; score += Math.min(35,Math.max(0,profit/10*35)); score += Math.min(25,Math.log10(Math.max(1,sales))*12); score += shipDays<=7?18:shipDays<=14?10:2; score += handlingDays<=2?8:handlingDays<=5?4:0; score += stock*.1; score += competition*.04;
  const highVolume=sales>=50&&profit>=5, preferred=profit>=10;
  const decision=(preferred||highVolume)&&shipDays<=21&&stock>=50?'review':profit>0?'reject':'reject';
  return {profitPerSale:Number(profit.toFixed(2)),projectedMonthlyProfit:Number(monthly.toFixed(2)),score:Number(Math.min(100,score).toFixed(1)),preferredTarget:preferred,highVolumeException:highVolume,decision,reason:decision==='review'?(preferred?'Meets preferred profit target':'High-volume exception qualifies'):'Below profit, speed, or stock thresholds'};
}
