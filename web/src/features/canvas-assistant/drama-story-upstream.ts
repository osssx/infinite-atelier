import type {CanvasConnection,CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";

/** Identity is for change detection, not a security or authenticity signature. */
export function storyTextDigest(text:string):string{
 let hash=2166136261;
 for(let i=0;i<text.length;i++){hash=Math.imul(hash^text.charCodeAt(i),16777619);}
 return "fnv1a:"+text.length+":"+(hash>>>0).toString(16).padStart(8,"0");
}
export type StoryTextSource={nodeId:string;edgeId:string;title:string;content:string;digest:string};
export type StoryTextSync=NonNullable<CanvasNodeMetadata["dramaTextSourceSync"]>;
export type StorySourceState="none"|"available"|"current"|"updated"|"disconnected"|"replaced"|"multiple";
export function storyTextSources(storyId:string,nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[]):StoryTextSource[]{
 const byId=new Map(nodes.map(node=>[node.id,node]));
 return connections.filter(edge=>edge.toNodeId===storyId).flatMap(edge=>{
  const source=byId.get(edge.fromNodeId);
  if(source?.type!=="text")return [];
  const content=source.metadata?.content??"";
  return [{nodeId:source.id,edgeId:edge.id,title:source.title||"文本节点",content,digest:storyTextDigest(content)}];
 });
}
export function storySourceState(sources:readonly StoryTextSource[],sync?:StoryTextSync):StorySourceState{
 if(!sources.length)return sync?"disconnected":"none";
 if(sources.length>1)return "multiple";
 const active=sync&&sources.find(s=>s.nodeId===sync.nodeId&&s.edgeId===sync.edgeId);
 if(active)return active.digest===sync.digest?"current":"updated";
 if(sync)return "replaced";
 return sources.length===1?"available":"multiple";
}
export function initialStoryTextImport(node:CanvasNodeData,sources:readonly StoryTextSource[]):Partial<CanvasNodeMetadata>|null{
 if(node.type!=="drama:source"||sources.length!==1||!sources[0].content.trim())return null;
 const meta=node.metadata;
 if(meta?.dramaTextSourceSync||meta?.dramaDraft?.trim()||meta?.content?.trim()||meta?.dramaConfirmed?.trim())return null;
 return storyTextSyncPatch(sources[0],"replace","");
}
/** Apply on the latest graph state, never based on a cached render snapshot. */
export function importBlankStoryNodes(nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[],
 skipStoryId?:string|null):CanvasNodeData[]{
 let changed=false;
 const result=nodes.map(node=>{
  if(node.type!=="drama:source"||node.id===skipStoryId)return node;
  const patch=initialStoryTextImport(node,storyTextSources(node.id,nodes,connections));
  if(!patch)return node;
  changed=true;
  return {...node,metadata:{...node.metadata,...patch}};
 });
 return changed?result:nodes as CanvasNodeData[];
}
export function storyTextSyncPatch(source:StoryTextSource,mode:"replace"|"append",currentDraft:string):
 Pick<CanvasNodeMetadata,"dramaDraft"|"content"|"dramaTextSourceSync">{
 const draft=mode==="replace"?source.content:
  currentDraft+(currentDraft&&source.content?(currentDraft.endsWith("\n")?"\n":"\n\n"):"")+source.content;
 return {dramaDraft:draft,content:draft,dramaTextSourceSync:{
  nodeId:source.nodeId,edgeId:source.edgeId,digest:source.digest,baselineDigest:storyTextDigest(draft)
 }};
}
export function storySourceParagraphChanges(current:string,incoming:string){
 const a=current.split(/\r?\n/).filter(Boolean),b=incoming.split(/\r?\n/).filter(Boolean);
 const unchanged=b.filter((text,i)=>a[i]===text).length;
 return {currentParagraphs:a.length,incomingParagraphs:b.length,changedParagraphs:Math.max(a.length,b.length)-unchanged};
}
