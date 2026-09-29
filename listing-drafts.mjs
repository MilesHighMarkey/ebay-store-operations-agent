export function buildDraft(input={}) {
  const name=String(input.name||'Product').trim(); const category=String(input.category||'Other').trim();
  const price=Number(input.salePrice||0), shipping=Number(input.supplierShipping||0), handling=Number(input.handlingDays||3), transit=Number(input.shipDays||14);
  return {title:name.slice(0,80),category,price:Number(price.toFixed(2)),shippingIncluded:true,handlingDays:handling,estimatedTransitDays:transit,itemSpecifics:input.itemSpecifics||{},description:`${name}\n\nProduct category: ${category}.\n\nPlease review the photos, compatibility information, variation, delivery estimate, and return terms before ordering. Supplier stock and delivery estimates must be rechecked before publication.`,riskFlags:[...(transit>14?['Long supplier transit']:[]),...(handling>5?['Long handling time']:[]),...(input.supplierAuthorized===false?['Supplier authorization not verified']:[])],status:'draft'};
}
