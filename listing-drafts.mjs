export function buildDraft(input={}) {
  const name=String(input.name||'Product').trim(); const category=String(input.category||'Other').trim();
  const price=Number(input.salePrice||0), shipping=Number(input.supplierShipping||0), handling=Number(input.handlingDays||3), transit=Number(input.shipDays||14);
  const origin=String(input.itemLocation||input.shipFrom||'Not provided').trim();
  const photos=Array.isArray(input.photos)?input.photos.filter(Boolean).slice(0,12):[];
  const returnTerms=input.returnTerms||{accepted:false,days:0,refund:'Supplier terms must be verified'};
  const riskFlags=[...(transit>14?['Long supplier transit']:[]),...(handling>5?['Long handling time']:[]),...(input.supplierAuthorized===false?['Supplier authorization not verified']:[]),...(origin==='Not provided'?['Item location not provided']:[]),...(photos.length===0?['Photos require review']:[])];
  return {
    title:name.slice(0,80),category,price:Number(price.toFixed(2)),shippingIncluded:true,
    shipping:{buyerCost:0,method:input.shippingMethod||'Standard shipping',costIncludedInPrice:true},
    handlingDays:handling,estimatedTransitDays:transit,
    estimatedDelivery:{minimumDays:handling+Math.max(1,transit-2),maximumDays:handling+transit+2},
    itemLocation:origin,photos,itemSpecifics:input.itemSpecifics||{},
    description:`${name}\n\nProduct category: ${category}.\n\nPlease review the photos, compatibility information, variation, delivery estimate, and return terms before ordering. Supplier stock and delivery estimates must be rechecked before publication.`,
    returnTerms,riskFlags,status:'draft',approvalRequired:true,publishable:false,sourceUrl:input.sourceUrl||null
  };
}
