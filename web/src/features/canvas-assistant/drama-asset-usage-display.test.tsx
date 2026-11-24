// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {CanvasNodeData,CanvasConnection} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import {buildDramaAssetUsage,collectDramaAssetUsage} from "./drama-asset-usage-display";
import {DramaAssetUsageTags} from "./drama-asset-usage-tags";

const ep="61ae1887-52cd-47e2-887b-cef1e33795da";
const node=(id:string,type:CanvasNodeData["type"],metadata:CanvasNodeData["metadata"]={}):CanvasNodeData=>({id,type,title:id,position:{x:0,y:0},metadata} as CanvasNodeData);
const shot=(id:string,order:number,refs:string[],episodeId=ep)=>({id,episodeId,order,description:"画面",characterVariantIds:refs,propIds:[],keyPropIds:[]});
const draft=(shots:ReturnType<typeof shot>[])=>JSON.stringify({shots});
const edge=(fromNodeId:string,toNodeId:string):CanvasConnection=>({id:fromNodeId+":"+toNodeId,fromNodeId,toNodeId});
it("uses readable episode numbering, numeric shot order and stable shot identity across boards and versions",()=>{
 const nodes=[
  node("assets","drama:assets"),
  node("episodes","drama:episodes",{dramaConfirmed:JSON.stringify({episodes:[{id:ep,title:"第一集",synopsis:"故事",events:[],sourceRefs:[],ending:"结束"}]})}),
  node("board","drama:storyboard",{dramaDraft:draft([shot("s11",11,["a"]),shot("s2",2,["a","v"])]),
   dramaConfirmed:draft([shot("s2",1,["a"]),shot("old",4,["v"])])}),
  node("other","drama:storyboard",{dramaDraft:draft([shot("s2",2,["a"])])}),
  node("unlinked","drama:storyboard",{dramaDraft:draft([shot("ignored",9,["a"])])}),
 ];
 const usage=buildDramaAssetUsage("assets",nodes,[edge("assets","board"),edge("episodes","board"),edge("assets","other")]);
 const entries=collectDramaAssetUsage(usage,["a","v"]);
 expect(entries.map(e=>e.label)).toEqual(["分镜 1 · 第 1 集 · 镜头 2","分镜 1 · 第 1 集 · 镜头 4","分镜 1 · 第 1 集 · 镜头 11","分镜 2 · 镜头 2"]);
 expect(new Set(entries.map(e=>e.key)).size).toBe(4);
 expect(usage.a).toHaveLength(3);expect(usage.v).toHaveLength(2);
 expect(JSON.stringify(entries.map(e=>e.label))).not.toContain(ep);
});
it("renders compact theme-aware tags and never exposes identity keys",async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 const div=document.createElement("div");document.body.append(div);const root=createRoot(div);
 const entries=[{key:ep,label:"镜头 1",rank:0},{key:"other",label:"镜头 1",rank:1}];
 try{
  for(const theme of [canvasThemes.light,canvasThemes.dark]){
   await act(async()=>root.render(<DramaAssetUsageTags entries={entries} theme={theme}/>));
   const section=div.querySelector("[data-asset-usage-tags]")!;
   expect(section.textContent).toContain("2 个镜头");
   expect(section.textContent).not.toContain(ep);
   const tags=[...section.querySelectorAll<HTMLElement>(".rounded-md")];
   expect(tags.map(t=>t.textContent)).toEqual(["镜头 1","镜头 1"]);
   expect(tags.every(t=>!!t.style.background&&!!t.style.borderColor&&!!t.style.color)).toBe(true);
  }
  await act(async()=>root.render(<DramaAssetUsageTags entries={[]} theme={canvasThemes.dark}/>));
  expect(div.textContent).toBe("");
 }finally{await act(async()=>root.unmount());div.remove();vi.unstubAllGlobals();}
});
