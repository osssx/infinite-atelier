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
export const storySourceLabels:Record<StorySourceState,string>={none:"未连接来源",available:"可导入新来源",
 current:"上游已同步",updated:"上游文本有更新",disconnected:"已同步来源断开",replaced:"原同步来源已替换",
 multiple:"检测到多个上游文本，请选择"};
/** Use readable names and ordinal disambiguation, never raw internal IDs. */
export function readableStoryLabels<T extends {title:string}>(items:readonly T[]){
 const totals=new Map<string,number>(),seen=new Map<string,number>();
 for(const item of items)totals.set(item.title,(totals.get(item.title)??0)+1);
 return items.map(item=>{
  const count=(seen.get(item.title)??0)+1;seen.set(item.title,count);
  return (totals.get(item.title)??0)>1?`${item.title}（${count}）`:item.title;
 });
}
export function storySourceSummary(sources:readonly StoryTextSource[],sync?:StoryTextSync){
 const state=storySourceState(sources,sync);
 const active=sync&&sources.find(item=>item.nodeId===sync.nodeId&&item.edgeId===sync.edgeId);
 const base=storySourceLabels[state];
 if(state==="disconnected")return base+" · 草案已保留";
 if(state==="multiple")return active?base+" · 上次："+readableStoryLabels(sources)[sources.indexOf(active)]+(active.digest===sync?.digest?"（已同步）":"（有更新）"):base;
 return sources[0]?base+" · "+sources[0].title:base;
}
export type StorySourceComparison={draft:string;source:StoryTextSource;syncKey:string};
const syncKey=(sync?:StoryTextSync)=>sync?JSON.stringify([sync.nodeId,sync.edgeId,sync.digest,sync.baselineDigest]):"";
export function createStorySourceComparison(draft:string,source:StoryTextSource,sync?:StoryTextSync):StorySourceComparison{
 return {draft,source:{...source},syncKey:syncKey(sync)};
}
export function storySourceComparisonIssue(compare:StorySourceComparison,draft:string,sources:readonly StoryTextSource[],sync?:StoryTextSync){
 if(draft!==compare.draft||syncKey(sync)!==compare.syncKey)return "故事草案或同步记录已变化，请重新比较";
 const current=sources.find(item=>item.nodeId===compare.source.nodeId&&item.edgeId===compare.source.edgeId);
 if(!current||current.digest!==compare.source.digest||current.content!==compare.source.content)
  return "上游连接或内容已变化，请重新比较";
 return "";
}
export type StorySyncState={node:CanvasNodeData;sources:readonly StoryTextSource[]};
export type StorySyncMode="replace"|"append";
/** Snapshot and recheck the same reviewed draft/source before committing. */
export async function applyReviewedStorySource({compare,mode,getCurrent,onBackup,onPersist,onPhase}:{
 compare:StorySourceComparison;mode:StorySyncMode;getCurrent:()=>StorySyncState|null;
 onBackup:()=>Promise<void>;onPersist:(patch:ReturnType<typeof storyTextSyncPatch>)=>Promise<void>;
 onPhase?:(phase:string)=>void;
}){
 const assertCurrent=(afterBackup=false)=>{
  const current=getCurrent();
  if(!current||current.node.type!=="drama:source")throw Error("故事节点已不存在");
  const metadata=current.node.metadata;
  const draft=metadata?.dramaDraft??metadata?.content??metadata?.dramaConfirmed??"";
  const issue=storySourceComparisonIssue(compare,draft,current.sources,metadata?.dramaTextSourceSync);
  if(issue)throw Error(afterBackup?"备份期间 "+issue+"，刷新已取消":issue);
 };
 assertCurrent();
 if(!compare.source.content.trim())throw Error("上游文本为空，无法同步");
 const needsBackup=mode==="replace"&&!!compare.draft.trim()&&compare.draft!==compare.source.content;
 if(needsBackup){
  onPhase?.("备份当前草案");
  await onBackup();
  assertCurrent(true);
 }
 onPhase?.("保存同步后的草案");
 await onPersist(storyTextSyncPatch(compare.source,mode,compare.draft));
 return needsBackup;
}
/** Build once for a semantic graph revision, not once per rendered story card. */
export function buildStoryTextSourceIndex(nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[]){
 const byId=new Map(nodes.map(node=>[node.id,node]));
 const index=new Map<string,StoryTextSource[]>(),digests=new Map<string,string>();
 for(const edge of connections){
  const source=byId.get(edge.fromNodeId),target=byId.get(edge.toNodeId);
  if(source?.type!=="text"||target?.type!=="drama:source")continue;
  const content=source.metadata?.content??"";
  let digest=digests.get(source.id);
  if(digest===undefined){digest=storyTextDigest(content);digests.set(source.id,digest);}
  const entry={nodeId:source.id,edgeId:edge.id,title:source.title||"文本节点",content,digest};
  const previous=index.get(target.id);
  if(previous)previous.push(entry);else index.set(target.id,[entry]);
 }
 return index;
}
export function storyTextSources(storyId:string,nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[]):StoryTextSource[]{
 return buildStoryTextSourceIndex(nodes,connections).get(storyId)??[];
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
 // A compact node with an unknown or nonempty stored body is never treated as a blank draft.
 if(meta?.creativePayloadRef&&(!meta.dramaStorySummary||meta.dramaStorySummary.hasStoredText))return null;
 return storyTextSyncPatch(sources[0],"replace","");
}
/** Apply on the latest graph state, never based on a cached render snapshot. */
export function importBlankStoryNodes(nodes:readonly CanvasNodeData[],connections:readonly CanvasConnection[],
 skipStoryId?:string|null):CanvasNodeData[]{
 let changed=false;
 const index=buildStoryTextSourceIndex(nodes,connections);
 const result=nodes.map(node=>{
  if(node.type!=="drama:source"||node.id===skipStoryId)return node;
  const patch=initialStoryTextImport(node,index.get(node.id)??[]);
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