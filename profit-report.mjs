export function profitReport(orders=[],costs={},feePct=14){
  const rows=orders.map(o=>{const revenue=Number(o.revenue||o.total||0),cost=Number(costs[o.sku]??o.supplierCost??0),shipping=Number(o.supplierShipping||0),fees=revenue*feePct/100,profit=revenue-fees-cost-shipping;return {...o,revenue,cost,shipping,fees:Number(fees.toFixed(2)),profit:Number(profit.toFixed(2))}});
  const total=key=>Number(rows.reduce((sum,row)=>sum+row[key],0).toFixed(2));
  return {orders:rows,summary:{orderCount:rows.length,revenue:total('revenue'),fees:total('fees'),supplierCosts:total('cost'),supplierShipping:total('shipping'),profit:total('profit'),averageProfitPerOrder:rows.length?Number((total('profit')/rows.length).toFixed(2)):0}};
}
