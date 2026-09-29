export function buildHealthReport(input={}) {
  const defects=Number(input.transactionDefectRate||0), late=Number(input.lateShipmentRate||0), tracking=Number(input.trackingValidatedPct||100), cases=Number(input.casesClosedWithoutResolution||0);
  const alerts=[]; if(defects>=2)alerts.push('Transaction defect rate is dangerous'); if(late>=4)alerts.push('Late shipment rate is dangerous'); if(tracking<95)alerts.push('Tracking validation is below target'); if(cases>0)alerts.push('Cases closed without seller resolution');
  return {sellerLevel:alerts.length?'at-risk':'healthy',metrics:{defects,late,tracking,cases},alerts,liveActionsRecommended:alerts.length===0};
}

export function deadlineAlerts(orders=[], now=new Date()) {
  return orders.flatMap(order=>{if(!order.shipBy)return[];const deadline=new Date(order.shipBy), hours=(deadline-now)/36e5;return hours<0?[{orderId:order.orderId,level:'overdue',hoursRemaining:Number(hours.toFixed(1))}]:hours<24?[{orderId:order.orderId,level:'urgent',hoursRemaining:Number(hours.toFixed(1))}]:[]});
}
