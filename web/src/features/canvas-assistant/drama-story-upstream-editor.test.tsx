// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
import {storyTextDigest,type StoryTextSource} from "./drama-story-upstream";
const mock=vi.hoisted(()=>({run:vi.fn(),ensure:vi.fn(async()=>{})}));
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("@/stores/use-config-store",()=>({
 useEffectiveConfig:()=>({textModel:"channel::test"}),
 resolveModelChannel:()=>({id:"channel",baseUrl:"http://localhost:8188",name:"test"}),
 modelOptionName:()=> "test"
}));
vi.mock("@/features/backend-sync/model-channel-autoroute",()=>({
 modelChannelProvider:()=> "openai_compatible",ensureSqliteModelChannelForExecution:()=>mock.ensure()
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:(...args:unknown[])=>mock.run(...args)}));
vi.mock("@/stores/canvas/use-canvas-store",()=>({awaitCanvasStorePersistence:vi.fn(async()=>{})}));
import {DramaStoryEditor} from "./drama-story-editor";
const roots:Root[]=[];
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);mock.run.mockReset();mock.run.mockResolvedValue({candidate:"改写候选"});});
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();});
const src=(content:string,nodeId="text-1",edgeId="edge-1"):StoryTextSource=>({content,nodeId,edgeId,title:"原稿-"+nodeId,digest:storyTextDigest(content)});
async function mount(options:{initial?:string;confirmed?:string;sources?:StoryTextSource[];
 snapshot?:()=>Promise<void>;sync?:CanvasNodeMetadata["dramaTextSourceSync"]}={}){
 const initial=options.initial??"旧草案正文";
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const patch=vi.fn<(value:Partial<CanvasNodeMetadata>)=>void>();
 const confirm=vi.fn(async()=>{});
 const snapshot=vi.fn(options.snapshot??(async()=>{}));
 let updateSources:(sources:StoryTextSource[])=>void=()=>{};
 const node={id:"story",type:"drama:source",title:"故事",position:{x:0,y:0},
  metadata:{dramaDraft:initial,content:initial,
   dramaConfirmed:options.confirmed,dramaConfirmedVersionId:options.confirmed?"version-1":undefined,
   dramaTextSourceSync:options.sync}} as CanvasNodeData;
 function View(){
  const [data,setData]=useState(node),[sources,setSources]=useState(options.sources??[]);
  updateSources=setSources;
  return <DramaStoryEditor node={data} projectId="p" versionBusy={false}
   upstreamSources={sources}
   onChange={value=>{patch(value);setData(old=>({...old,metadata:{...old.metadata,...value}}));}}
   onSnapshotDraft={snapshot} onConfirmVersion={confirm}/>;
 }
 await act(async()=>root.render(<View/>));
 return {container,patch,confirm,snapshot,updateSources:async(sources:StoryTextSource[])=>{
  await act(async()=>updateSources(sources));
 }};
}
async function click(el:Element|null|undefined){
 expect(el).toBeTruthy();await act(async()=>{(el as HTMLElement).click();await Promise.resolve();});
}
async function write(el:HTMLTextAreaElement,value:string){
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(el,value);
  el.dispatchEvent(new Event("input",{bubbles:true}));});
}
const button=(container:Element,label:string)=>[...container.querySelectorAll("button")].find(b=>b.textContent?.includes(label));
it("compares and replaces story draft after saving a recovery snapshot, while preserving V1",async()=>{
 const {container,snapshot,patch,confirm}=await mount({confirmed:"已确认 V1",sources:[src("新故事正文")]});
 expect(container.querySelector('[data-story-upstream-panel]')?.textContent).toContain("可导入新来源");
 await click(button(container,"比较差异"));
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="当前故事对比正文"]')?.value).toBe("旧草案正文");
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')?.value).toBe("新故事正文");
 await click(button(container,"用上游替换当前草案"));
 expect(snapshot).toHaveBeenCalledTimes(1);
 expect(patch).toHaveBeenCalledWith(expect.objectContaining({
  dramaDraft:"新故事正文",content:"新故事正文",
  dramaTextSourceSync:{nodeId:"text-1",edgeId:"edge-1",digest:storyTextDigest("新故事正文"),
   baselineDigest:storyTextDigest("新故事正文")}
 }));
 expect(patch.mock.lastCall?.[0]).not.toHaveProperty("dramaConfirmed");
 expect(confirm).not.toHaveBeenCalled();
 expect(container.querySelector('[data-story-upstream-panel]')?.textContent).toContain("上游已同步");
});
it("canceling comparison and disconnecting retains draft, and appended content keeps confirmed V1",async()=>{
 const s=src("新故事");
 const {container,patch,updateSources}=await mount({confirmed:"已确认 V1",sources:[s]});
 await click(button(container,"比较差异"));
 await click(button(container,"取消"));
 expect(patch).not.toHaveBeenCalled();
 await click(button(container,"追加草案"));
 expect(patch).toHaveBeenCalledWith(expect.objectContaining({dramaDraft:"旧草案正文\n\n新故事"}));
 const prior=patch.mock.lastCall?.[0] as Partial<CanvasNodeMetadata>;
 expect(prior).not.toHaveProperty("dramaConfirmed");
 await updateSources([]);
 expect(container.querySelector('[data-story-upstream-panel]')?.textContent).toContain("已同步来源断开");
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="故事完整正文"]')?.value)
  .toContain("新故事");
});
it("blocks refresh while unsaved edits or AI candidate are present",async()=>{
 const {container,patch}=await mount({sources:[src("新故事")]});
 const story=container.querySelector<HTMLTextAreaElement>('[aria-label="故事完整正文"]')!;
 await write(story,"正在手动写的文字");
 expect((button(container,"刷新草案") as HTMLButtonElement)?.disabled).toBe(true);
 expect(patch).not.toHaveBeenCalled();
});
it("failed snapshot leaves story unchanged and permits retry",async()=>{
 const snapshot=vi.fn(async()=>{throw Error("backup_failed");});
 const {container,patch}=await mount({sources:[src("新内容")],snapshot});
 await click(button(container,"刷新草案"));
 await click(button(container,"用上游替换当前草案"));
 expect(snapshot).toHaveBeenCalledOnce();
 expect(patch).not.toHaveBeenCalled();
 expect(container.textContent).toContain("backup_failed");
 expect(container.querySelector('[data-story-upstream-compare]')).toBeTruthy();
});
it("stops stale replacement when the story changes during asynchronous snapshot",async()=>{
 let resolve:()=>void=()=>{};
 const promise=new Promise<void>(r=>{resolve=r;});
 const {container,patch}=await mount({sources:[src("新内容")],snapshot:()=>promise});
 await click(button(container,"比较差异"));
 await act(async()=>{(button(container,"用上游替换当前草案") as HTMLElement).click();await Promise.resolve();});
 const story=container.querySelector<HTMLTextAreaElement>('[aria-label="故事完整正文"]')!;
 await write(story,"另一个修改");
 await act(async()=>{resolve();await promise;});
 expect(patch).not.toHaveBeenCalled();
 expect(story.value).toBe("另一个修改");
 expect(container.textContent).toContain("刷新已取消");
});
it("rejects source changes during the recovery snapshot, without overwriting the draft",async()=>{
 let resolve:()=>void=()=>{};
 const promise=new Promise<void>(r=>{resolve=r;});
 const {container,patch,updateSources}=await mount({sources:[src("上游旧内容")],snapshot:()=>promise});
 await click(button(container,"比较差异"));
 await act(async()=>{(button(container,"用上游替换当前草案") as HTMLElement).click();await Promise.resolve();});
 await updateSources([src("更新后的上游内容")]);
 await act(async()=>{resolve();await promise;});
 expect(patch).not.toHaveBeenCalled();
 expect(container.textContent).toContain("上游内容在备份期间变化");
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="故事完整正文"]')?.value).toBe("旧草案正文");
});
it("can choose another upstream text explicitly; no source is imported simply by connecting",async()=>{
 const {container,patch}=await mount({sources:[src("第一来源"),src("第二来源","text-2","edge-2")]});
 expect(container.querySelector('[data-story-upstream-panel]')?.textContent).toContain("多个上游");
 expect(patch).not.toHaveBeenCalled();
 await act(async()=>{
  const select=container.querySelector<HTMLSelectElement>('[aria-label="选择故事上游文本"]')!;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(select,"edge-2");
  select.dispatchEvent(new Event("change",{bubbles:true}));
 });
 await click(button(container,"刷新草案"));
 expect(container.querySelector<HTMLTextAreaElement>('[aria-label="上游文本对比正文"]')?.value).toBe("第二来源");
 await click(button(container,"用上游替换当前草案"));
 expect(patch.mock.lastCall?.[0]).toMatchObject({dramaDraft:"第二来源",dramaTextSourceSync:{nodeId:"text-2"}});
});
