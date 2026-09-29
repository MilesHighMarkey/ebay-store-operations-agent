export function approvalCard(approval){
  return [`STORE AGENT APPROVAL`,`Action: ${approval.action}`,`Item: ${approval.item}`,`Status: ${approval.status}`,`Approval ID: ${approval.id}`,`Approve/reject only after reviewing the dashboard.`].join('\n');
}
export async function sendApprovalCard(approval){
  if(!process.env.TELEGRAM_BOT_TOKEN||!process.env.TELEGRAM_CHAT_ID)return {sent:false,mode:'dry-run',text:approvalCard(approval)};
  const response=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text:approvalCard(approval)})});
  return {sent:response.ok,status:response.status};
}
