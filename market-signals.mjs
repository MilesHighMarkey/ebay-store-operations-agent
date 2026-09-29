export function scoreMarketSignal(input={}){
  const sales=Number(input.sales30d||0), views=Number(input.views30d||0), watchers=Number(input.watchers30d||0), sellers=Number(input.competitorCount||0);
  const conversion=views? sales/views:0, watchRate=views?watchers/views:0;
  const score=Math.min(100,Math.round(Math.min(45,sales*2)+Math.min(25,conversion*1000)+Math.min(15,watchRate*300)+Math.max(0,15-Math.min(15,sellers))));
  return {score,signals:{sales30d:sales,views30d:views,watchers30d:watchers,competitorCount:sellers,conversion:Number(conversion.toFixed(4)),watchRate:Number(watchRate.toFixed(4))},interpretation:score>=70?'strong demand':score>=45?'promising demand':'weak or insufficient evidence'};
}
