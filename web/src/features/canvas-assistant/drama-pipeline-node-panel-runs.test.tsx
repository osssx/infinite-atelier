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
