// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {CanvasNodeData,CanvasNodeMetadata} from "@/types/canvas";
const api=vi.hoisted(()=>({run:vi.fn(),ensure:vi.fn(async()=>{})}));
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("@/stores/use-config-store",()=>({
 useEffectiveConfig:()=>({textModel:"channel::story-model"}),
 resolveModelChannel:()=>({id:"channel",baseUrl:"http://localhost:8188",name:"测试模型"}),
 modelOptionName:()=> "story-model"
}));
vi.mock("@/features/backend-sync/model-channel-autoroute",()=>({
 modelChannelProvider:()=> "openai_compatible",
 ensureSqliteModelChannelForExecution:()=>api.ensure()
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({
 canvasApi:(...args:unknown[])=>api.run(...args)
}));
vi.mock("@/stores/canvas/use-canvas-store",()=>({awaitCanvasStorePersistence:vi.fn(async()=>{})}));
import {DramaStoryEditor} from "./drama-story-editor";
const roots:Root[]=[];
beforeEach(()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 api.run.mockReset();api.run.mockResolvedValue({candidate:"新段落"});
 api.ensure.mockReset();
});
afterEach(async()=>{
 for(const root of roots)await act(async()=>root.unmount());
 roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();
});
const initial="开场\n旧段落\n结局";
async function mount(raw=initial,persist:()=>Promise<void>=async()=>{}){
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const patch=vi.fn<(value:Partial<CanvasNodeMetadata>)=>void>();
 const confirm=vi.fn(async()=>{});
 const pending=new Map<string,()=>Promise<void>>();
 const track=vi.fn((id:string,save:(()=>Promise<void>)|null)=>{
  if(save)pending.set(id,save);else pending.delete(id);
 });
 const node:CanvasNodeData={id:"story",type:"drama:source",title:"故事",position:{x:0,y:0},
  width:400,height:300,metadata:{dramaDraft:raw,content:raw}} as CanvasNodeData;
 function View(){
  const [value,setValue]=useState(node);
  return <DramaStoryEditor node={value} projectId="project-1" versionBusy={false}
   onChange={async change=>{await persist();patch(change);setValue(old=>({...old,metadata:{...old.metadata,...change}}));}}
   onConfirmVersion={confirm} onPendingChange={track}/>;
 }
 await act(async()=>{root.render(<View/>);});
 return {container,patch,confirm,pending,track};
}
async function click(el:Element|null|undefined){
 expect(el).toBeTruthy();
 await act(async()=>{(el as HTMLElement).click();await Promise.resolve();});
}
async function typeText(el:HTMLTextAreaElement,value:string){
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(el,value);
  el.dispatchEvent(new Event("input",{bubbles:true}));
 });
}
const byText=(container:Element,label:string)=>[...container.querySelectorAll("button")].find(b=>b.textContent?.trim()===label);
async function openAI(container:Element){await click(byText(container,"AI 创作"));}
it("rewrites only the selected story range after preview, accept, and save",async()=>{
 const {container,patch,pending}=await mount();
 await openAI(container);
 const field=container.querySelector<HTMLTextAreaElement>('[aria-label="故事完整正文"]')!;
 const start=initial.indexOf("旧段落");
 await act(async()=>{
  field.focus();
  field.setSelectionRange(start,start+3);
  field.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));
 });
 expect(container.querySelector<HTMLButtonElement>('[aria-label="改写选中内容"]')?.disabled).toBe(false);
 await click(container.querySelector('[aria-label="改写选中内容"]'));
 expect(api.ensure).toHaveBeenCalledTimes(1);
 expect(api.run.mock.calls[0][0]).toContain("/drama-pipeline/story-edit");
 expect(api.run.mock.calls[0][2]).toMatchObject({mode:"selection",selectedText:"旧段落"});
 expect(patch).not.toHaveBeenCalled();
 expect(field.value).toBe(initial);
 expect(container.querySelector('[data-story-ai-candidate]')).toBeTruthy();
 expect(pending.size).toBe(1);
 await click([...container.querySelectorAll("button")].find(b=>b.textContent==="采用候选"));
 expect(field.value).toBe("开场\n新段落\n结局");
 expect(patch).not.toHaveBeenCalled();
 await click([...container.querySelectorAll("button")].find(b=>b.textContent?.includes("保存草案")));
 expect(patch).toHaveBeenCalledWith({dramaDraft:"开场\n新段落\n结局",content:"开场\n新段落\n结局"});
 expect(pending.size).toBe(0);
});
it("discards AI candidate without touching story, then confirms original version",async()=>{
 const {container,patch,confirm}=await mount();
 await openAI(container);
 await click(container.querySelector('[aria-label="全文润色"]'));
 await click([...container.querySelectorAll("button")].find(b=>b.textContent==="放弃候选"));
 expect(container.querySelector('[data-story-ai-candidate]')).toBeNull();
 expect(patch).not.toHaveBeenCalled();
 await click([...container.querySelectorAll("button")].find(b=>b.textContent==="确认故事版本"));
 expect(confirm).toHaveBeenCalledWith(initial);
});
it("prevents accepting an AI candidate generated for an outdated text snapshot",async()=>{
 const {container,patch}=await mount();
 await openAI(container);
 await click(container.querySelector('[aria-label="全文改写"]'));
 await click(container.querySelector('[aria-label="编辑故事正文"]'));
 const field=container.querySelector<HTMLTextAreaElement>('[aria-label="故事完整正文"]')!;
 await typeText(field,"外部手动修改");
 const accept=[...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="采用候选")!;
 expect(accept.disabled).toBe(true);
 expect(container.querySelector('[data-story-ai-candidate]')?.textContent).toContain("已过期");
 expect(patch).not.toHaveBeenCalled();
});
it("cancels a pending AI request without applying a late reply",async()=>{
 let resolve:(value:{candidate:string})=>void=()=>{};
 api.run.mockImplementationOnce(()=>new Promise(resolvePromise=>{resolve=resolvePromise}));
 const {container,patch}=await mount();
 await openAI(container);
 await click(container.querySelector('[aria-label="AI 续写"]'));
 expect(container.textContent).toContain("AI 生成中");
 await click([...container.querySelectorAll("button")].find(b=>b.textContent?.includes("停止等待")));
 await act(async()=>resolve({candidate:"过期生成"}));
 expect(container.querySelector('[data-story-ai-candidate]')).toBeNull();
 expect(patch).not.toHaveBeenCalled();
});
it("starts read-only, stages edits and cancels without a graph write",async()=>{
 const {container,patch,pending}=await mount();
 const field=container.querySelector<HTMLTextAreaElement>('[data-story-textarea]')!;
 expect(field.readOnly).toBe(true);
 expect(container.querySelector('[aria-label="故事 AI 创作"]')).toBeNull();
 await click(container.querySelector('[aria-label="编辑故事正文"]'));
 expect(field.readOnly).toBe(false);
 await typeText(field,"本地稿");
 expect(pending.size).toBe(1);expect(patch).not.toHaveBeenCalled();
 await click(byText(container,"取消"));
 expect(field.readOnly).toBe(true);expect(field.value).toBe(initial);
 expect(pending.size).toBe(0);expect(patch).not.toHaveBeenCalled();
});
it("keeps a failed save pending, retries, then returns to read-only only after persistence",async()=>{
 let resolve:()=>void=()=>{};
 const persist=vi.fn<()=>Promise<void>>().mockRejectedValueOnce(Error("落盘失败"))
  .mockImplementationOnce(()=>new Promise<void>(r=>{resolve=r;}));
 const {container,patch,pending}=await mount(initial,persist);
 const field=container.querySelector<HTMLTextAreaElement>('[data-story-textarea]')!;
 await click(container.querySelector('[aria-label="编辑故事正文"]'));
 await typeText(field,"持久化稿");
 await click(byText(container,"保存草案"));
 expect(container.textContent).toContain("落盘失败");expect(field.value).toBe("持久化稿");
 expect(pending.size).toBe(1);expect(field.dataset.storyMode).toBe("editing");expect(patch).not.toHaveBeenCalled();
 await click(byText(container,"保存草案"));
 expect(pending.size).toBe(1);expect(field.dataset.storyMode).toBe("editing");
 await act(async()=>resolve());
 expect(pending.size).toBe(0);expect(field.readOnly).toBe(true);
 expect(patch).toHaveBeenCalledWith({dramaDraft:"持久化稿",content:"持久化稿"});
});
it("stopping during channel synchronization prevents a late model request",async()=>{
 let resolve:()=>void=()=>{};
 api.ensure.mockImplementationOnce(()=>new Promise<void>(r=>{resolve=r;}));
 const {container}=await mount();
 await openAI(container);
 await click(container.querySelector('[aria-label="AI 续写"]'));
 await click(byText(container,"停止等待"));
 await act(async()=>resolve());
 expect(api.run).not.toHaveBeenCalled();
});