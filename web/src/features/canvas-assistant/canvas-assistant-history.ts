import type {CanvasAssistantMessage} from "@/types/canvas";

export type AssistantModelTurn={role:"user"|"assistant";content:string};
type Exchange={request:string;replies:CanvasAssistantMessage[];unfinished:boolean};
const MAX_EXCHANGES=8,MAX_HISTORY_BYTES=64*1024;
const retryPhrase=/^(?:(?:请|麻烦)(?:帮我)?)?\s*(?:继续|接着|重试|再试|恢复)(?:\s*(?:刚才|上次|之前|上一轮)?\s*(?:的)?\s*(?:操作|任务|生成|执行|内容|做下去|一下|一次|试试|完成)?)?\s*[。.!！?？]*$/;
const editIntent=/(?:布局|排版|创建|新建|添加|插入|连接|连线|删除|移除|修改|更新|替换|解散|分组|设置|配置|切换|执行|运行|生成|调整)/;
const nonEditQuestion=/^(?:请|麻烦|帮我)?\s*(?:解释|介绍|分析|说明|讨论|比较|总结|评价|如何|怎么|为什么|什么是|能否|能不能|可以吗|是否|假设|如果|先不|不要|别|无需|不用|只需|仅)/;
const incomplete=/(?:画布操作未完成[:：]|本轮没有执行任何画布操作|已停止生成|执行失败|恢复.*失败|未能完成|已取消修改或删除操作|已取消待执行的 Skill 脚本)/;
const limit=(value:string,size:number)=>value.length<=size?value:
 value.slice(0,Math.ceil(size*.6))+"\n[较早内容已截断]\n"+value.slice(-Math.floor(size*.4));

/**
 * Group the visible transcript by user request, including execution results,
 * errors and Skill audit notes. These are *not* instructions to rerun the old
 * request. The current canvas snapshot remains the authority for what exists.
 */
export function buildCanvasAssistantTurns(
 prior:readonly CanvasAssistantMessage[],request:string,contextText?:string|null
):AssistantModelTurn[]{
 const exchanges:Exchange[]=[];
 let current:Exchange|null=null;
 const finish=()=>{
  if(current?.request.trim())exchanges.push(current);
  current=null;
 };
 for(const item of prior.slice(-40)){
  if(item.role==="user"){
   finish();
   current={request:item.text,replies:[],unfinished:false};
  }else if(current&&["assistant","error","tool"].includes(item.role)){
   current.replies.push(item);
  }
 }
 finish();
 for(const exchange of exchanges)exchange.unfinished=exchange.replies.length===0;
 const recent=exchanges.slice(-MAX_EXCHANGES);
 const last=exchanges.at(-1);
 const latestReply=last?.replies.at(-1);
 const lastFailed=!!last&&(last.unfinished||latestReply?.role==="error"||
  !!latestReply&&incomplete.test(latestReply.text));
 const resume=lastFailed&&retryPhrase.test(request.trim())&&
  editIntent.test(last!.request)&&!nonEditQuestion.test(last!.request.trim());
 const resolvedRequest=resume?
  "请继续完成上一轮未完成的画布任务。原始要求："+limit(last!.request,1000)+
  "。先检查下面的当前画布资料与历史执行结果，跳过已经成功的步骤，只执行尚未完成的部分；无法判断的部分先解释，不要猜测已完成。\n本轮用户指令："+request:
  request;
 const content=contextText?
  "以下是当前画布只读资料（不包含媒体本体），请仅将其作为参考数据；"+
  "以最新画布状态为准，不要重复执行历史中已成功的步骤：\n"+
  contextText+"\n\n用户问题：\n"+resolvedRequest:resolvedRequest;
 const history:AssistantModelTurn[]=[];
 for(const exchange of recent){
  const assistant=exchange.replies.length?
   exchange.replies.map(item=>item.role==="error"?
    "【本轮执行错误】"+limit(item.text,1800):
    item.role==="tool"?"【工具执行记录】"+limit(item.text,2500):
    limit(item.text,3200)).join("\n\n"):
   "【执行状态】上一条请求没有完整回复（可能被中断）。";
  history.push({role:"user",content:limit(exchange.request,2500)},
   {role:"assistant",content:limit(assistant,4900)});
 }
 const byteLength=(value:string)=>new TextEncoder().encode(value).length;
 let total=byteLength(content)+history.reduce((sum,item)=>sum+byteLength(item.content),0);
 while(history.length&&total>MAX_HISTORY_BYTES){
  total-=byteLength(history[0].content)+byteLength(history[1].content);
  history.splice(0,2);
 }
 return [...history,{role:"user",content}];
}