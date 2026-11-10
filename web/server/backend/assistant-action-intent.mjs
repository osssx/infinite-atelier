/**
 * A narrow, local intent guard, not a substitute for an LLM-generated action plan.
 * Only an unambiguous whole-canvas dependency layout can be resolved without a model plan.
 */
export function latestCanvasUserRequest(content){
 if(typeof content!=="string")return "";
 const marker="\n用户问题：\n";
 const markerAt=content.lastIndexOf(marker);
 return (markerAt<0?content:content.slice(markerAt+marker.length)).trim();
}
export function isCanvasEditInstruction(content){
 const request=latestCanvasUserRequest(content);
 if(!request||request.length>12000)return false;
 // A question, negative instruction or hypothetical must never trigger a canvas write.
 if(/^(?:(?:请|麻烦|帮我|你能)?(?:解释|介绍|分析|说明|讨论|比较|总结|评价)|如何|怎么|为什么|什么是|能否|能不能|可以吗|是否|要不要|如果|假设|假如|只需|只要|仅|先不)/.test(request))return false;
 if(/^(?:不要|别|请勿|禁止|先不要)|(?:不要执行|别执行|无需执行|不用操作|不需要执行|仅讨论|只回复|只分析|只要建议|只给建议|预览|假设|如果|建议如何|应该如何|怎么做|怎么办|是什么|会怎样|能否|可以吗|能不能|是否应该|模拟|演示|示例|给我.*建议)/.test(request))return false;
 return /(?:布局|排版|排列|整理(?:画布|节点|工作流)|创建|新建|添加|插入|连接|连线|删除|移除|修改|更新|替换|解散|分组|调整.*位置)/.test(request);
}
export function exactWholeCanvasGraphLayout(content){
 const request=latestCanvasUserRequest(content);
 if(!isCanvasEditInstruction(request))return null;
 if(!/(?:整个画布|全画布|画布(?:上|中)?(?:的)?所有节点|全部节点|所有节点|整个工作流|完整工作流|全工作流)/.test(request))return null;
 if(!/(?:连线|依赖|拓扑|工作流(?:的)?(?:执行)?顺序|流程关系)/.test(request))return null;
 if(!/(?:布局|排版|排列|整理)/.test(request))return null;
 // Not a single bounded layout request if the user also asks to edit graph contents.
 if(/(?:并(?:且)?|同时|然后|再|顺便|之后|先).*(?:创建|新建|添加|删除|移除|修改|更新|替换|连接|断开|分组|解散|执行|生成)/.test(request)||
  /^(?:创建|新建|添加|删除|移除|修改|更新|替换|连接|断开|解散|生成)/.test(request))
  return null; const vertical=/(?:从上到下|自上而下|由上至下|纵向|竖向)/.test(request);
 const horizontal=/(?:从左到右|自左向右|由左至右|横向)/.test(request);
 if(vertical&&horizontal)return null;
 return {type:"layout_graph",nodeIds:[],direction:vertical?"vertical":"horizontal",gap:48,layerGap:140};
}
