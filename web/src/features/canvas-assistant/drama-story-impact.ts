import type {CanvasConnection,CanvasNodeData} from "@/types/canvas";
import {readableStoryLabels} from "./drama-story-upstream";

const kindNames:Record<string,string>={"drama:assets":"资产规划","drama:episodes":"剧集规划","drama:storyboard":"分镜配置",
 "drama:source":"故事","text":"文本节点","config":"生成配置","image":"图像节点","video":"视频节点","audio":"音频节点"};
export type StoryDownstreamStatus="recorded"|"review"|"unknown"|"unconfirmed"|"direct";
export type StoryDownstream={nodeId:string;title:string;kind:string;status:StoryDownstreamStatus;detail:string;connections:number};
/** Only live direct edges and recorded version identities, never infer indirect impact. */
export function storyDirectDownstream(story:CanvasNodeData,nodes:readonly CanvasNodeData[],edges:readonly CanvasConnection[]):StoryDownstream[]{
 const byId=new Map(nodes.map(node=>[node.id,node]));
 const byTarget=new Map<string,CanvasConnection[]>();
 for(const edge of edges)if(edge.fromNodeId===story.id&&edge.toNodeId!==story.id&&byId.has(edge.toNodeId)){
  const list=byTarget.get(edge.toNodeId)??[];list.push(edge);byTarget.set(edge.toNodeId,list);
 }
 const confirmedId=story.metadata?.dramaConfirmedVersionId;
 const hasConfirmed=Boolean(story.metadata?.dramaConfirmed?.trim()||confirmedId);
 const entries:StoryDownstream[]=[];
 for(const [nodeId,links] of byTarget){
  const node=byId.get(nodeId)!;
  const kind=kindNames[node.type]??"画布节点";
  const title=node.title||kind;
  let status:StoryDownstreamStatus="direct",detail="真实直连；该节点未评估内容影响，需人工复核。";
  if(node.type==="drama:assets"||node.type==="drama:episodes"||node.type==="drama:storyboard"){
   if(!hasConfirmed){status="unconfirmed";detail="故事尚无已确认版本，不能据此判断下游影响。";}
   else if(!confirmedId){status="unknown";detail="当前故事缺少稳定确认版本记录，请复核关联。";}
   else{
    const deps=node.metadata?.dramaInputDependencies;
    const matching=links.map(edge=>deps?.find(dep=>dep.nodeId===story.id&&dep.edgeId===edge.id));
    if(matching.some(dep=>dep?.revisionId&&dep.revisionId!==confirmedId)){
     status="review";detail="下游记录的是旧故事确认版本，请复核后续内容。";
    }else if(matching.some(dep=>!dep?.revisionId)){
     status="unknown";detail="存在新增连接或缺少对应依赖版本记录，请复核。";
    }else{
     status="recorded";detail="已记录当前故事确认版本；未检查其他来源或具体事件、镜头。";
    }
   }
  }
  entries.push({nodeId,title,kind,status,detail,connections:links.length});
 }
 const names=readableStoryLabels(entries);
 return entries.map((entry,i)=>({...entry,title:names[i]}));
}
