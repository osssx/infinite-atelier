import {expect,it} from "vitest";
import type {CanvasConnection,CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {storyDirectDownstream} from "./drama-story-impact";
const node=(id:string,type:string,metadata:CanvasNodeMetadata={},title=id)=>({id,type,title,position:{x:0,y:0},metadata}) as CanvasNodeData;
const edge=(id:string,fromNodeId:string,toNodeId:string)=>({id,fromNodeId,toNodeId}) as CanvasConnection;
const story=node("story","drama:source",{dramaConfirmed:"V2",dramaConfirmedVersionId:"v2"});
const dep=(edgeId:string,revisionId:string)=>({nodeId:"story",edgeId,revisionId,digest:"digest",entries:[]});
it("uses actual direct edges and recorded revisions, never traverses to indirect shots or orphan nodes",()=>{
 const nodes=[story,node("assets","drama:assets",{dramaInputDependencies:[dep("a","v2")]}),
  node("episodes","drama:episodes",{dramaInputDependencies:[dep("b","v1")]}),
  node("board","drama:storyboard"),node("text","text"),node("orphan","drama:assets")];
 const links=[edge("a","story","assets"),edge("b","story","episodes"),edge("c","episodes","board"),
  edge("d","story","text"),edge("e","story","missing"),edge("f","story","story")];
 expect(storyDirectDownstream(story,nodes,links).map(v=>[v.nodeId,v.status])).toEqual([
  ["assets","recorded"],["episodes","review"],["text","direct"]]);
});
it("requires an exact edge and source identity, and groups multiple links with human readable duplicate labels",()=>{
 const a=node("a","drama:assets",{dramaInputDependencies:[dep("1","v2"),{...dep("2","v2"),nodeId:"different"}]},"规划");
 const b=node("b","drama:episodes",{dramaInputDependencies:[dep("3","v1")]},"规划");
 const result=storyDirectDownstream(story,[story,a,b],[edge("1","story","a"),edge("2","story","a"),edge("3","story","b")]);
 expect(result.map(v=>[v.title,v.status,v.connections])).toEqual([["规划（1）","unknown",2],["规划（2）","review",1]]);
});
it("does not claim current version for an unconfirmed story or a legacy confirmation with no stable ID",()=>{
 const a=node("a","drama:assets");const e=edge("1","story","a");
 const unconfirmed=node("story","drama:source",{dramaDraft:"draft"});
 const legacy=node("story","drama:source",{dramaConfirmed:"legacy"});
 expect(storyDirectDownstream(unconfirmed,[unconfirmed,a],[e])[0].status).toBe("unconfirmed");
 expect(storyDirectDownstream(legacy,[legacy,a],[e])[0].status).toBe("unknown");
 expect(storyDirectDownstream(story,[story,a],[e])[0].status).toBe("unknown");
});
