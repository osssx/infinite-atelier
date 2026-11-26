// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {CanvasNodeData,CanvasNodeMetadata,CanvasConnection} from "@/types/canvas";
import {storyTextDigest,type StoryTextSource} from "./drama-story-upstream";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("@/stores/use-config-store",()=>({
 useEffectiveConfig:()=>({textModel:"channel::test"}),
 resolveModelChannel:()=>({id:"channel",baseUrl:"http://localhost:8188",name:"test"}),
 modelOptionName:()=> "test"
}));
vi.mock("@/features/backend-sync/model-channel-autoroute",()=>({
 modelChannelProvider:()=> "openai_compatible",ensureSqliteModelChannelForExecution:vi.fn(async()=>{})
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn()}));
vi.mock("@/stores/canvas/use-canvas-store",()=>({awaitCanvasStorePersistence:vi.fn(async()=>{})}));
import {DramaStoryEditor} from "./drama-story-editor";
import {DramaStoryHistorySummary} from "./drama-story-history-summary";
import {DramaStoryHistoryNavigationContext} from "./drama-story-history-navigation";
const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();});
const src=(content:string,nodeId="text-1",edgeId="edge-1",title="原稿"):StoryTextSource=>({content,nodeId,edgeId,title,digest:storyTextDigest(content)});
const node=(metadata:CanvasNodeMetadata,id="story",type="drama:source",title="故事")=>({id,type,title,position:{x:0,y:0},metadata}) as CanvasNodeData;
async function mount(options:{initial?:string;confirmed?:string;sources?:StoryTextSource[];nodes?:CanvasNodeData[];
 connections?:CanvasConnection[];metadata?:CanvasNodeMetadata;snapshot?:()=>Promise<void>;persist?:()=>Promise<void>;
 sync?:CanvasNodeMetadata["dramaTextSourceSync"]}={}){
 const initial=options.initial??"旧草案正文";
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const patch=vi.fn<(value:Partial<CanvasNodeMetadata>)=>void>();
 const snapshot=vi.fn(options.snapshot??(async()=>{}));
 const original=node({dramaDraft:initial,content:initial,dramaConfirmed:options.confirmed,
  dramaConfirmedVersionId:options.confirmed?"version-1":undefined,dramaTextSourceSync:options.sync,...options.metadata});
 let current=original;
 let updateSources:(sources:StoryTextSource[])=>void=()=>{};
 let updateStory:(text:string)=>void=()=>{};
 let setBusy:(busy:boolean)=>void=()=>{};
 function View(){
  const [data,setData]=useState(original),[sources,setSources]=useState(options.sources??[]),[busy,setVersionBusy]=useState(false);
  current=data;updateSources=setSources;setBusy=setVersionBusy;
  updateStory=text=>setData(old=>({...old,metadata:{...old.metadata,dramaDraft:text,content:text}}));
  return <DramaStoryHistorySummary node={data} sources={sources} nodes={[data,...(options.nodes??[])]} connections={options.connections??[]}
   versionBusy={busy} onChange={async value=>{await options.persist?.();patch(value);setData(old=>({...old,metadata:{...old.metadata,...value}}));}}
   onSnapshotDraft={snapshot}/>;
 }
 await act(async()=>root.render(<View/>));
 return {container,patch,snapshot,metadata:()=>current.metadata,
  updateStory:async(text:string)=>{await act(async()=>updateStory(text));},
  updateSources:async(sources:StoryTextSource[])=>{await act(async()=>updateSources(sources));},
  busy:async(value:boolean)=>{await act(async()=>setBusy(value));}};
}
async function click(el:Element|null|undefined){
 expect(el).toBeTruthy();await act(async()=>{(el as HTMLElement).click();await Promise.resolve();});
}
async function write(el:HTMLTextAreaElement,value:string){
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(el,value);
  el.dispatchEvent(new Event("input",{bubbles:true}));});
}
const button=(container:Element,label:string)=>[...container.querySelectorAll("button")].find(b=>b.textContent?.trim()===label);
const comparison=(container:Element)=>container.querySelector('[data-story-upstream-compare]');
it("compares and replaces a persisted draft only after a recovery snapshot, while preserving V1",async()=>{
 const {container,snapshot,patch,metadata}=await mount({confirmed:"已确认 V1",sources:[src("新故事正文")]});
 expect(container.querySelector('[data-story-upstream-panel]')?.textContent).toContain("可导入新来源");
 await click(button(container,"比较差异"));
 expect(button(container,"用上游替换当前草案")).toBeUndefined();expect(patch).not.toHaveBeenCalled();
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="当前故事对比正文"]')?.value).toBe("旧草案正文");
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')?.value).toBe("新故事正文");
 await click(button(container,"替换预览"));expect(patch).not.toHaveBeenCalled();
 await click(button(container,"用上游替换当前草案"));expect(snapshot).toHaveBeenCalledTimes(1);
 expect(patch).toHaveBeenCalledWith({dramaDraft:"新故事正文",content:"新故事正文",
  dramaTextSourceSync:{nodeId:"text-1",edgeId:"edge-1",digest:storyTextDigest("新故事正文"),baselineDigest:storyTextDigest("新故事正文")}});
 expect(metadata()?.dramaConfirmed).toBe("已确认 V1");expect(metadata()?.dramaConfirmedVersionId).toBe("version-1");
 expect(container.textContent).toContain("上游已同步");expect(comparison(container)).toBeNull();
});
it("requires an exact append preview; cancel and disconnect preserve prior draft and confirmation",async()=>{
 const {container,patch,updateSources,snapshot,metadata}=await mount({confirmed:"已确认 V1",sources:[src("新故事")]});
 await click(button(container,"追加预览"));expect(patch).not.toHaveBeenCalled();
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="追加草案预览"]')?.value).toBe("旧草案正文\n\n新故事");
 await click(button(container,"取消"));expect(patch).not.toHaveBeenCalled();
 await click(button(container,"追加预览"));await click(button(container,"追加到当前草案"));
 expect(snapshot).not.toHaveBeenCalled();expect(metadata()?.dramaDraft).toBe("旧草案正文\n\n新故事");
 expect(metadata()?.dramaConfirmed).toBe("已确认 V1");
 await updateSources([]);expect(container.textContent).toContain("已同步来源断开");expect(metadata()?.dramaDraft).toContain("新故事");
});
it("blocks source mutation during a shared version operation",async()=>{
 const {container,patch,busy}=await mount({sources:[src("新故事")]});
 await click(button(container,"替换预览"));await busy(true);
 expect((button(container,"用上游替换当前草案") as HTMLButtonElement).disabled).toBe(true);
 expect(patch).not.toHaveBeenCalled();await busy(false);expect((button(container,"用上游替换当前草案") as HTMLButtonElement).disabled).toBe(false);
});
it("a failed backup leaves the frozen preview and can be retried",async()=>{
 const snapshot=vi.fn<()=>Promise<void>>().mockRejectedValueOnce(Error("backup_failed")).mockResolvedValue(undefined);
 const {container,patch,metadata}=await mount({sources:[src("新内容")],snapshot});
 await click(button(container,"替换预览"));await click(button(container,"用上游替换当前草案"));
 expect(snapshot).toHaveBeenCalledOnce();expect(patch).not.toHaveBeenCalled();expect(container.textContent).toContain("backup_failed");
 expect(comparison(container)).toBeTruthy();expect(metadata()?.dramaDraft).toBe("旧草案正文");
 await click(button(container,"用上游替换当前草案"));expect(metadata()?.dramaDraft).toBe("新内容");
});
it("a persistence failure keeps the comparison and permits retry",async()=>{
 const persist=vi.fn<()=>Promise<void>>().mockRejectedValueOnce(Error("persist_failed")).mockResolvedValue(undefined);
 const {container,patch,metadata}=await mount({sources:[src("新内容")],persist});
 await click(button(container,"替换预览"));await click(button(container,"用上游替换当前草案"));
 expect(patch).not.toHaveBeenCalled();expect(metadata()?.dramaDraft).toBe("旧草案正文");
 expect(container.textContent).toContain("persist_failed");expect(comparison(container)).toBeTruthy();
 await click(button(container,"用上游替换当前草案"));expect(metadata()?.dramaDraft).toBe("新内容");
});
it("stops replacement if the draft changes while awaiting backup",async()=>{
 let resolve:()=>void=()=>{};const promise=new Promise<void>(r=>{resolve=r;});
 const {container,patch,updateStory,metadata}=await mount({sources:[src("新内容")],snapshot:()=>promise});
 await click(button(container,"比较差异"));await click(button(container,"替换预览"));await click(button(container,"用上游替换当前草案"));
 await updateStory("另一个修改");await act(async()=>{resolve();await promise;});
 expect(patch).not.toHaveBeenCalled();expect(metadata()?.dramaDraft).toBe("另一个修改");expect(container.textContent).toContain("刷新已取消");
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="当前故事对比正文"]')?.value).toBe("旧草案正文");
});
it("stops replacement if the source changes during backup",async()=>{
 let resolve:()=>void=()=>{};const promise=new Promise<void>(r=>{resolve=r;});
 const {container,patch,updateSources,metadata}=await mount({sources:[src("上游旧内容")],snapshot:()=>promise});
 await click(button(container,"比较差异"));await click(button(container,"替换预览"));await click(button(container,"用上游替换当前草案"));
 await updateSources([src("更新后的上游内容")]);await act(async()=>{resolve();await promise;});
 expect(patch).not.toHaveBeenCalled();expect(container.textContent).toContain("刷新已取消");expect(metadata()?.dramaDraft).toBe("旧草案正文");
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')?.value).toBe("上游旧内容");
});
it("never silently swaps an open preview when source or draft changes, including digest collisions",async()=>{
 const original=src("第一版本");const {container,patch,updateSources,updateStory}=await mount({sources:[original]});
 await click(button(container,"追加预览"));await updateSources([{...original,content:"新版本同摘要"}]);
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')?.value).toBe("第一版本");
 expect(button(container,"追加到当前草案")).toBeUndefined();expect(container.textContent).toContain("请重新比较");
 await updateStory("新草案");await click(button(container,"重新比较"));
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="当前故事对比正文"]')?.value).toBe("新草案");
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')?.value).toBe("新版本同摘要");
 expect(patch).not.toHaveBeenCalled();
});
it("does not guess among multiple unlinked sources, disambiguates names without GUIDs",async()=>{
 const {container,patch}=await mount({sources:[src("第一来源","guid-a","edge-a"),src("第二来源","guid-b","edge-b")]});
 const select=container.querySelector<HTMLSelectElement>('[aria-label="选择故事上游文本"]')!;
 expect(select.value).toBe("");expect(select.textContent).toContain("原稿（1）");expect(select.textContent).toContain("原稿（2）");
 expect(select.textContent).not.toContain("guid-");expect((button(container,"比较差异") as HTMLButtonElement).disabled).toBe(true);
 await act(async()=>{select.value="edge-b";select.dispatchEvent(new Event("change",{bubbles:true}));});
 await click(button(container,"比较差异"));expect(container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')?.value).toBe("第二来源");
 await click(button(container,"替换预览"));await click(button(container,"用上游替换当前草案"));expect(patch.mock.lastCall?.[0]).toMatchObject({dramaDraft:"第二来源",dramaTextSourceSync:{nodeId:"guid-b"}});
});
it("does not refresh a frozen preview against a different source when its original connection is gone",async()=>{
 const {container,patch,updateSources}=await mount({sources:[src("旧来源")]});
 await click(button(container,"比较差异"));
 await updateSources([src("其他来源","another-node","another-edge","另一份原稿")]);
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')?.value).toBe("旧来源");
 expect((button(container,"重新比较") as HTMLButtonElement).disabled).toBe(true);
 expect(button(container,"替换预览")).toBeUndefined();
 expect(container.textContent).toContain("原来源已断开或为空");
 await click(button(container,"取消"));await click(button(container,"比较差异"));
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')?.value).toBe("其他来源");
 expect(patch).not.toHaveBeenCalled();
});
it("exposes append result and the frozen source independently without writes",async()=>{
 const {container,patch}=await mount({sources:[src("新故事")]});
 await click(button(container,"追加预览"));
 const result=container.querySelector<HTMLTextAreaElement>('[aria-label="追加草案预览"]')!;
 const source=container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')!;
 expect(result.readOnly).toBe(true);expect(result.value).toBe("旧草案正文\n\n新故事");
 expect(source.parentElement?.style.display).toBe("none");
 await click(button(container,"上游文本"));
 expect(source.readOnly).toBe(true);expect(source.value).toBe("新故事");
 expect(result.parentElement?.style.display).toBe("none");
 await click(button(container,"操作后草案"));
 expect(result.parentElement?.style.display).not.toBe("none");expect(patch).not.toHaveBeenCalled();
});
it("shows absent or disconnected sources without opening a preview or rendering writable controls",async()=>{
 const {container,metadata}=await mount({sync:{nodeId:"text-1",edgeId:"edge-1",digest:"old",baselineDigest:"old"},confirmed:"V1",sources:[]});
 expect(container.textContent).toContain("已同步来源断开");expect(container.textContent).toContain("草案和已确认版本均已保留");
 expect(button(container,"比较差异")).toBeUndefined();expect(comparison(container)).toBeNull();expect(metadata()?.dramaDraft).toBe("旧草案正文");
 const empty=await mount();expect(empty.container.textContent).toContain("暂无关联上游文本");
});
it("shows only one source status row in正文, with navigation routed to the shared workspace guard",async()=>{
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const navigate=vi.fn(),persist=vi.fn(async()=>{}),pending=new Map<string,()=>Promise<void>>();
 await act(async()=>root.render(<DramaStoryHistoryNavigationContext.Provider value={navigate}>
  <DramaStoryEditor node={node({dramaDraft:"正文"})} projectId="p" versionBusy={false} upstreamSources={[src("原文")]}
   onChange={persist} onPendingChange={(key,save)=>{if(save)pending.set(key,save);else pending.delete(key);}}/>
 </DramaStoryHistoryNavigationContext.Provider>));
 expect(container.querySelector('[data-story-source-status]')?.textContent).toContain("可导入新来源");
 expect(container.querySelector('[data-story-upstream-panel]')).toBeNull();expect(container.querySelector('[data-story-upstream-compare]')).toBeNull();
 await click(container.querySelector('[aria-label="编辑故事正文"]'));
 await write(container.querySelector<HTMLTextAreaElement>('[data-story-textarea]')!,"未保存草案");
 expect(pending.size).toBe(1);await click(button(container,"查看来源"));
 expect(navigate).toHaveBeenCalledOnce();expect(persist).not.toHaveBeenCalled();expect(pending.size).toBe(1);
});
it("shows readable paragraph provenance, current visual snapshot and honest direct downstream state",async()=>{
 const target=node({dramaInputDependencies:[{nodeId:"story",edgeId:"edge-one",revisionId:"old-version",digest:"digest",entries:[]}]},"guid-downstream","drama:assets","角色规划");
 const {container}=await mount({confirmed:"V1",nodes:[target],connections:[{id:"edge-one",fromNodeId:"story",toNodeId:target.id} as CanvasConnection],
  metadata:{dramaSourceParagraphs:[{id:"guid-paragraph",text:"正文第一段",line:1,status:"needs_review",replaces:["guid-previous"]}],
   dramaConfirmedVisual:{visualStyle:"水彩",artDirection:{palette:"暖色"}}}});
 expect(container.querySelector('[data-story-direct-downstream]')?.textContent).toContain("角色规划");
 const downstream=container.querySelector('[data-story-downstream-status="review"]')!;
 expect(downstream).toBeTruthy();expect(downstream.textContent).not.toContain("下游记录的是旧故事确认版本");
 await click(downstream.querySelector("button"));expect(downstream.textContent).toContain("下游记录的是旧故事确认版本");
 await click(downstream.querySelector("button"));expect(downstream.textContent).not.toContain("下游记录的是旧故事确认版本");
 expect(container.textContent).not.toContain("guid-");
 await click(button(container,"已确认原文定位 · 1 段展开"));
 expect(container.textContent).toContain("第 1 段");expect(container.textContent).toContain("待校对");
 expect(container.textContent).toContain("关联旧段落 1 个");expect(container.textContent).not.toContain("guid-");
 await click(button(container,"当前已确认美术快照展开"));
 expect(container.textContent).toContain("水彩");expect(container.textContent).toContain("暖色");
});