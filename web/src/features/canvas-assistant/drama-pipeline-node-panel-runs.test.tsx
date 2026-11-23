// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";

vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({
 canvasApi:vi.fn(async(path:string)=>path.includes("/drama-pipeline/runs?")
  ?[{id:"candidate-1",episodeId:"毛毛和豆豆",status:"ready"}]:{})
}));

import {DramaPipelineNodePanel} from "./drama-pipeline-node-panel";

const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{
 for(const root of roots)await act(async()=>root.unmount());
 roots.length=0;
 vi.unstubAllGlobals();
});

it("keeps a real gap between candidate title and unshrunk status label",async()=>{
 const node={id:"episodes-1",type:"drama:episodes",title:"剧集规划",position:{x:0,y:0},
  metadata:{dramaDraft:JSON.stringify({episodes:[]})}} as CanvasNodeData;
 const container=document.createElement("div");
 document.body.append(container);
 const root=createRoot(container);roots.push(root);
 await act(async()=>{
  root.render(<DramaPipelineNodePanel node={node} onChange={()=>{}}
   projectId="project-1" workspaceMode workspaceTab="runs"/>);
 });
 await act(async()=>await Promise.resolve());
 const summary=[...container.querySelectorAll("details summary")].find(
  item=>item.textContent?.includes("ready · 待采用"));
 expect(summary).toBeTruthy();
 const content=summary?.querySelector<HTMLElement>("[data-drama-run-summary-content]");
 expect(content?.classList.contains("gap-2")).toBe(true);
 expect(content?.classList.contains("items-center")).toBe(true);
 expect(content?.children).toHaveLength(2);
 expect(content?.children[0].classList.contains("flex-1")).toBe(true);
 expect(content?.children[0].classList.contains("truncate")).toBe(true);
 expect(content?.children[1].classList.contains("shrink-0")).toBe(true);
 expect(content?.children[1].classList.contains("whitespace-nowrap")).toBe(true);
 expect(content?.children[0].textContent).toContain("毛毛和豆豆");
 expect(content?.children[1].textContent).toContain("ready · 待采用");
});
it("keeps the maximized storyboard footer to one themed toolbar; scopes and migration live in a popover",async()=>{
 const {useThemeStore}=await import("@/stores/use-theme-store");
 useThemeStore.setState({theme:"dark"});
 const node={id:"storyboard-1",type:"drama:storyboard",title:"分镜配置",position:{x:0,y:0},
  metadata:{dramaDraft:JSON.stringify({shots:[
   {id:"shot-1",episodeId:"episode-1",order:1,description:"森林入口",characterVariantIds:[],propIds:[],keyPropIds:[]}
  ]})}} as CanvasNodeData;
 const upstreamArtifacts=[
  JSON.stringify({assets:[{id:"scene-1",kind:"scene",name:"森林",description:"",sourceRefs:[]}]}),
  JSON.stringify({episodes:[{id:"episode-1",title:"毛毛和豆豆",synopsis:"",ending:"",events:[],sourceRefs:[],
   sequences:[{id:"sequence-1",title:"森林入口"}]}]})
 ];
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 await act(async()=>root.render(<DramaPipelineNodePanel node={node}
  upstreamArtifacts={upstreamArtifacts} initialEpisodeId="episode-1" onChange={()=>{}}
  projectId="project-1" workspaceMode workspaceTab="editor"/>));
 const toolbar=container.querySelector<HTMLElement>('[data-drama-storyboard-toolbar]')!;
 expect(toolbar).toBeTruthy();
 expect(toolbar.getAttribute("aria-label")).toBe("分镜生成与确认工具栏");
 expect(toolbar.classList.contains("flex")).toBe(true);
 expect(toolbar.classList.contains("grid-cols-2")).toBe(false);
 expect(toolbar.querySelectorAll("button")).toHaveLength(4);
 expect(toolbar.textContent).toContain("生成范围");
 expect(toolbar.textContent).toContain("校验分镜");
 expect(toolbar.textContent).toContain("生成分镜候选");
 expect(toolbar.textContent).toContain("确认阶段");
 expect(toolbar.querySelector('[data-drama-storyboard-scope-summary]')?.textContent)
  .toContain("毛毛和豆豆");
 expect(container.querySelector('[data-drama-sequence-migration]')).toBeNull();
 expect(container.querySelector('select[aria-label="生成范围：场次"]')).toBeNull();
 await act(async()=>{
  toolbar.querySelector<HTMLButtonElement>('[aria-label="设置分镜生成范围"]')!.click();
  await new Promise(resolve=>setTimeout(resolve,70));
 });
 const popup=document.querySelector<HTMLElement>('[data-drama-storyboard-options]')!;
 expect(popup).toBeTruthy();
 expect(popup.querySelector('select[aria-label="生成范围：剧集"]')).toBeTruthy();
 expect(popup.querySelector('select[aria-label="生成范围：场次"]')).toBeTruthy();
 expect(popup.querySelector('select[aria-label="生成范围：镜头"]')).toBeTruthy();
 expect(popup.querySelector('[data-drama-sequence-migration]')).toBeTruthy();
 expect(popup.style.background).toBe((await import("@/lib/canvas-theme")).canvasThemes.dark.node.panel);
 await act(async()=>useThemeStore.setState({theme:"light"}));
 expect(toolbar.style.borderColor).toBe((await import("@/lib/canvas-theme")).canvasThemes.light.node.stroke);
 expect(document.querySelector<HTMLElement>('[data-drama-storyboard-options]')?.style.background)
  .toBe((await import("@/lib/canvas-theme")).canvasThemes.light.node.panel);
 const sequence=popup.querySelector<HTMLSelectElement>('select[aria-label="生成范围：场次"]')!;
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(sequence,"sequence-1");
  sequence.dispatchEvent(new Event("change",{bubbles:true}));
 });
 expect(toolbar.querySelector('[data-drama-storyboard-scope-summary]')?.textContent)
  .toContain("森林入口");
});
