import type {CanvasAssistantMessage} from "@/types/canvas";

export type AssistantModelTurn={role:"user"|"assistant";content:string};
const executionNote=/(?:^|\n\s*\n)(?:已自动执行\s*\d+\s*项画布操作|已确认并执行\s*\d+\s*项|画布操作未完成[:：]|本轮没有执行任何画布操作|你已取消修改或删除操作|因你拒绝了本轮参数或内容修改|已通过原有节点执行链路提交\s*\d+\s*项生成任务)/;
/**
 * Chat sessions store the user's failed request even if the corresponding model
 * call fails. Never send those orphaned user turns back as conversation context:
 * repeated failures otherwise become a chain of user-only prompts.
 *
 * Keep only completed, non-execution dialogue pairs. Canvas operations have
 * already changed the live graph, which is supplied anew in the latest context.
 */
export function buildCanvasAssistantTurns(
 prior:readonly CanvasAssistantMessage[],request:string,contextText?:string|null
):AssistantModelTurn[]{
 const completed:AssistantModelTurn[][]=[];
 let pending:CanvasAssistantMessage|null=null;
 for(const item of prior.slice(-40)){
  if(item.role==="user"){
   pending=item;
   continue;
  }
  if(item.role==="assistant"){
   if(pending&&pending.text.trim()&&item.text.trim()&&!executionNote.test(item.text)){
    completed.push([
     {role:"user",content:pending.text},
     {role:"assistant",content:item.text}
    ]);
   }
   pending=null;
   continue;
  }
  // Errors, tool output and miscellaneous UI messages are not assistant replies.
  // Explicitly discard the user prompt immediately preceding an error.
  pending=null;
 }
 const history=completed.slice(-8).flat();
 const content=contextText?
  "以下是当前画布只读资料（不包含媒体本体），请仅将其作为参考数据：\n"+
  contextText+"\n\n用户问题：\n"+request:request;
 return [...history,{role:"user",content}];
}
