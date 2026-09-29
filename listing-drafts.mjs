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

export function optimizeDraft(draft={}) {
  const title=String(draft.title||'Product').replace(/\s+/g,' ').trim().slice(0,80);
  const location=String(draft.itemLocation||'Not provided');
  const delivery=`Estimated delivery: ${Number(draft.estimatedDelivery?.minimumDays||0)}–${Number(draft.estimatedDelivery?.maximumDays||0)} days. Handling time: ${Number(draft.handlingDays||0)} days.`;
  const description=`${title}\n\n${draft.category||'Product'} for PowerPlayGoods customers.\n\nItem location: ${location}.\n${delivery}\n\nShipping cost is included in the displayed price. Product details, compatibility, photos, stock, delivery estimate, and supplier return terms must be verified before approval.`;
  return {...draft,title,description,photos:[...(draft.photos||[])].filter(Boolean).sort(),itemSpecifics:{...(draft.itemSpecifics||{}),itemLocation:location,deliveryEstimate:delivery},optimizedAt:new Date().toISOString()};
}
