// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
import {DramaSourceNode} from "./drama-source-node";
vi.mock("./drama-story-state",async importOriginal=>{
 const actual=await importOriginal<typeof import("./drama-story-state")>();
 return {...actual,resolveStorySummary:vi.fn(actual.resolveStorySummary)};
});
import {resolveStoryDraft,resolveStorySummary,storyVersionConfirmed} from "./drama-story-state";
const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();});
const node=(metadata:CanvasNodeMetadata)=>({id:"source-1",type:"drama:source",title:"故事",position:{x:0,y:0},width:340,height:350,metadata}) as CanvasNodeData;
it("renders only a bounded story summary, style, ratio and source status",async()=>{
 const element=document.createElement("div");document.body.append(element);
 const root=createRoot(element);roots.push(root);
 const onOpen=vi.fn();
 await act(async()=>root.render(<DramaSourceNode node={node({
  dramaDraft:"这是一段相当长的故事。".repeat(200),videoRatio:"16:9",dramaFilmStyle:"水彩动画"})}
  onOpenEditor={onOpen} sourceState="updated"/>));
 const preview=element.querySelector<HTMLButtonElement>('[data-story-inline-summary]')!;
 expect(preview.textContent).toContain("完整编辑器");
 expect(preview.textContent!.length).toBeLessThan(470);
 expect(element.querySelector("textarea,select,input,details")).toBeNull();
 expect(element.textContent).toContain("水彩动画");
 expect(element.textContent).toContain("16:9");
 expect(element.textContent).toContain("上游文本有更新");
 expect(element.textContent).not.toContain("确认原文");
 await act(async()=>preview.click());
 expect(onOpen).toHaveBeenCalledTimes(1);
});
it("compares empty drafts and visual snapshots consistently while ignoring video ratio",()=>{
 const confirmed={dramaDraft:"正文",dramaConfirmed:"正文",dramaFilmStyle:"风格",
  dramaConfirmedVisual:{visualStyle:"风格",artDirection:{palette:"绿"}},
  dramaArtDirection:{palette:"绿",lighting:"",characterDesign:"",anchors:""}};
 expect(storyVersionConfirmed(node(confirmed))).toBe(true);
 expect(storyVersionConfirmed(node({...confirmed,videoRatio:"9:16"}))).toBe(true);
 expect(storyVersionConfirmed(node({...confirmed,dramaFilmStyle:"新风格"}))).toBe(false);
 expect(storyVersionConfirmed(node({...confirmed,dramaArtDirection:{...confirmed.dramaArtDirection,palette:"蓝"}}))).toBe(false);
 expect(storyVersionConfirmed(node({...confirmed,dramaConfirmedVisual:undefined}))).toBe(true);
 expect(resolveStoryDraft(node({...confirmed,dramaDraft:"",content:"旧文"}))).toBe("");
 expect(storyVersionConfirmed(node({...confirmed,dramaDraft:"",content:"旧文"}))).toBe(false);
});
it("renders compact previews and confirmation status without exposing them as a draft",async()=>{
 const element=document.createElement("div");document.body.append(element);
 const root=createRoot(element);roots.push(root);
 const compact={creativePayloadRef:{nodeId:"source-1",schemaVersion:1 as const}};
 const projected={...compact,dramaStorySummary:{preview:"已保存的故事",length:980,hasText:true,
  confirmedTextMatches:true,hadConfirmed:true,hasStoredText:true}};
 await act(async()=>root.render(<DramaSourceNode node={node(projected)} onOpenEditor={()=>{}}/>));
 expect(element.textContent).toContain("已保存的故事");
 expect(element.textContent).toContain("980 字符");
 expect(storyVersionConfirmed(node(projected))).toBe(true);
 expect(resolveStoryDraft(node(projected))).toBe("");
 await act(async()=>root.render(<DramaSourceNode node={node(compact)} onOpenEditor={()=>{}}/>));
 expect(element.textContent).toContain("摘要暂不可用");
 expect(element.textContent).not.toContain("尚无故事正文");
});
it("does not recompute a long story summary on geometry-only parent renders; semantic edits still invalidate it",async()=>{
 const element=document.createElement("div");document.body.append(element);
 const root=createRoot(element);roots.push(root);
 const onOpenEditor=vi.fn();
 const content="长故事段落：主角沿河岸前进。\n".repeat(3000);
 const original=node({content,dramaDraft:content,dramaConfirmed:content});
 await act(async()=>root.render(<DramaSourceNode node={original} onOpenEditor={onOpenEditor} sourceState="current"/>));
 const summary=vi.mocked(resolveStorySummary);summary.mockClear();
 for(let frame=0;frame<12;frame++){
  const next={...original,position:{x:frame*4,y:frame*2}};
  await act(async()=>root.render(<DramaSourceNode node={next} onOpenEditor={onOpenEditor} sourceState="current"/>));
 }
 expect(summary).not.toHaveBeenCalled();
 await act(async()=>root.render(<DramaSourceNode node={original} onOpenEditor={onOpenEditor} sourceState="updated"/>));
 expect(summary).toHaveBeenCalled();
 expect(element.textContent).toContain("上游文本有更新");
 summary.mockClear();
 const edited={...original,metadata:{...original.metadata,dramaDraft:"新草案"}};
 await act(async()=>root.render(<DramaSourceNode node={edited} onOpenEditor={onOpenEditor} sourceState="updated"/>));
 expect(summary).toHaveBeenCalled();expect(element.textContent).toContain("新草案");
});