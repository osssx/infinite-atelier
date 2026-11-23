import {describe,it,expect} from "vitest";
import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
import {importBlankStoryNodes,initialStoryTextImport,storySourceState,storyTextDigest,storyTextSources,
 storyTextSyncPatch,storySourceParagraphChanges} from "./drama-story-upstream";
const node=(id:string,type:CanvasNodeData["type"],content="",confirmed="")=>({
 id,type,title:id,position:{x:0,y:0},metadata:type==="text"?{content}:
 {dramaDraft:content,content,dramaConfirmed:confirmed}
}) as CanvasNodeData;
const edge=(id:string,fromNodeId:string,toNodeId="story")=>({id,fromNodeId,toNodeId}) as CanvasConnection;
describe("story upstream text synchronization",()=>{
 it("imports only a sole linked nonempty text into an empty unconfirmed story and records provenance",()=>{
  const nodes=[node("story","drama:source"),node("text-1","text","来自文本的故事")];
  const sources=storyTextSources("story",nodes,[edge("edge-1","text-1")]);
  expect(sources).toHaveLength(1);
  const patch=initialStoryTextImport(nodes[0],sources)!;
  expect(patch.dramaDraft).toBe("来自文本的故事");
  expect(patch.content).toBe("来自文本的故事");
  expect(patch).not.toHaveProperty("dramaConfirmed");
  expect(patch.dramaTextSourceSync).toEqual({nodeId:"text-1",edgeId:"edge-1",
   digest:storyTextDigest("来自文本的故事"),baselineDigest:storyTextDigest("来自文本的故事")});
  expect(initialStoryTextImport({...nodes[0],metadata:{...patch}},sources)).toBeNull();
 });
 it("automatically imports after a new connection, but not while the story editor is open",()=>{
  const nodes=[node("story","drama:source"),node("text-1","text","首次正文")];
  const connections=[edge("edge-1","text-1")];
  expect(importBlankStoryNodes(nodes,[])).toBe(nodes);
  expect(importBlankStoryNodes(nodes,connections,"story")).toBe(nodes);
  const updated=importBlankStoryNodes(nodes,connections);
  expect(updated).not.toBe(nodes);
  expect(updated[0].metadata?.dramaDraft).toBe("首次正文");
  expect(updated[0].metadata?.dramaConfirmed).toBe("");
  expect(importBlankStoryNodes(updated,connections)).toBe(updated);
 });
 it("never auto-overwrites existing drafts, existing confirmed versions or ambiguous connections",()=>{
  const text=node("text-1","text","新内容");
  const source=[edge("edge-1","text-1")];
  expect(initialStoryTextImport(node("story","drama:source","旧草案"),storyTextSources("story",
   [node("story","drama:source","旧草案"),text],source))).toBeNull();
  const published=node("story","drama:source","","旧确认");
  expect(initialStoryTextImport(published,storyTextSources("story",[published,text],source))).toBeNull();
  const blank=node("story","drama:source");
  expect(initialStoryTextImport(blank,storyTextSources("story",[blank,text,node("text-2","text","另一个")],
   [...source,edge("edge-2","text-2")]))).toBeNull();
 });
 it("detects upstream edits, replacement and disconnection without deleting published content",()=>{
  const source={nodeId:"a",edgeId:"e1",title:"原稿",content:"初稿",digest:storyTextDigest("初稿")};
  const patch=storyTextSyncPatch(source,"replace","");
  const saved=patch.dramaTextSourceSync!;
  expect(storySourceState([source],saved)).toBe("current");
  expect(storySourceState([{...source,content:"第二稿",digest:storyTextDigest("第二稿")}],saved)).toBe("updated");
  expect(storySourceState([],saved)).toBe("disconnected");
  expect(storySourceState([source,{...source,nodeId:"b",edgeId:"e2"}],saved)).toBe("multiple");
  expect(storySourceState([{...source,edgeId:"e2"}],saved)).toBe("replaced");
  expect(storySourceState([{...source,nodeId:"b",edgeId:"e3"}],saved)).toBe("replaced");
 });
 it("can append or replace draft while leaving confirmed version and lineage untouched",()=>{
  const source={nodeId:"text",edgeId:"edge",title:"新原稿",content:"新故事",digest:storyTextDigest("新故事")};
  const published="已确认 V1";
  const original={dramaDraft:"当前草案",dramaConfirmed:published,dramaConfirmedVersionId:"version-v1"};
  const append={...original,...storyTextSyncPatch(source,"append",original.dramaDraft)};
  expect(append.dramaDraft).toBe("当前草案\n\n新故事");
  expect(append.dramaConfirmed).toBe(published);
  expect(append.dramaConfirmedVersionId).toBe("version-v1");
  expect(append.dramaTextSourceSync!.baselineDigest).toBe(storyTextDigest(append.dramaDraft));
  const replace={...append,...storyTextSyncPatch(source,"replace",append.dramaDraft)};
  expect(replace.dramaDraft).toBe("新故事");
  expect(replace.dramaConfirmed).toBe(published);
 });
 it("reports text differences without mutating input snapshots",()=>{
  const current="一段\n另一段",incoming="一段\n修改后的第二段\n新增";
  expect(storySourceParagraphChanges(current,incoming)).toEqual({
   currentParagraphs:2,incomingParagraphs:3,changedParagraphs:2});
  expect(storyTextDigest(incoming)).not.toBe(storyTextDigest(current));
 });
});
