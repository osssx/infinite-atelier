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
import type {StoryTextSource} from "./drama-story-upstream";
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
 let updateSource=(text:string)=>{void text;};
 let updateSources=(sources:StoryTextSource[])=>{void sources;};
 function View(){
  const [value,setValue]=useState(node);
  const [sources,setSources]=useState<StoryTextSource[]>([]);
  updateSource=text=>setValue(old=>({...old,metadata:{...old.metadata,dramaDraft:text,content:text}}));
  updateSources=setSources;
  return <DramaStoryEditor node={value} upstreamSources={sources} projectId="project-1" versionBusy={false}
   onChange={async change=>{await persist();patch(change);setValue(old=>({...old,metadata:{...old.metadata,...change}}));}}
   onConfirmVersion={confirm} onPendingChange={track}/>;
 }
 await act(async()=>{root.render(<View/>);});
 return {container,patch,confirm,pending,track,updateSource,updateSources};
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
async function generate(container:Element,operation?:"续写"|"改写"|"润色"){
 if(operation)await click(byText(container,operation));
 await click(byText(container,"生成候选"));
}
async function selectRange(field:HTMLTextAreaElement,start:number,end:number){
 await act(async()=>{field.focus();field.setSelectionRange(start,end);field.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));});
}
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
 await generate(container,"改写");
 expect(api.ensure).toHaveBeenCalledTimes(1);
 expect(api.run.mock.calls[0][0]).toContain("/drama-pipeline/story-edit");
 expect(api.run.mock.calls[0][2]).toMatchObject({mode:"selection",selectedText:"旧段落"});
 expect(patch).not.toHaveBeenCalled();
 expect(field.value).toBe(initial);
 expect(container.querySelector('[data-story-ai-candidate]')).toBeTruthy();
 expect(pending.size).toBe(1);
 await click([...container.querySelectorAll("button")].find(b=>b.textContent==="采用到草案"));
 expect(field.value).toBe("开场\n新段落\n结局");
 expect(patch).not.toHaveBeenCalled();
 await click([...container.querySelectorAll("button")].find(b=>b.textContent?.includes("保存草案")));
 expect(patch).toHaveBeenCalledWith({dramaDraft:"开场\n新段落\n结局",content:"开场\n新段落\n结局"});
 expect(pending.size).toBe(0);
});
it("discards AI candidate without touching story, then confirms original version",async()=>{
 const {container,patch,confirm}=await mount();
 await openAI(container);
 await generate(container,"润色");
 await click([...container.querySelectorAll("button")].find(b=>b.textContent==="舍弃候选"));
 expect(container.querySelector('[data-story-ai-candidate]')).toBeNull();
 expect(patch).not.toHaveBeenCalled();
 await click([...container.querySelectorAll("button")].find(b=>b.textContent==="确认故事版本"));
 expect(confirm).toHaveBeenCalledWith(initial);
});
it("prevents accepting an AI candidate generated for an outdated text snapshot",async()=>{
 const {container,patch}=await mount();
 await openAI(container);
 await generate(container,"改写");
 await click(container.querySelector('[aria-label="编辑故事正文"]'));
 const field=container.querySelector<HTMLTextAreaElement>('[aria-label="故事完整正文"]')!;
 await typeText(field,"外部手动修改");
 const accept=[...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="采用到草案")!;
 expect(accept.disabled).toBe(true);
 expect(container.querySelector('[data-story-ai-candidate]')?.textContent).toContain("已过期");
 expect(patch).not.toHaveBeenCalled();
});
it("cancels a pending AI request without applying a late reply",async()=>{
 let resolve:(value:{candidate:string})=>void=()=>{};
 api.run.mockImplementationOnce(()=>new Promise(resolvePromise=>{resolve=resolvePromise}));
 const {container,patch}=await mount();
 await openAI(container);
 await generate(container);
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
 await generate(container);
 await click(byText(container,"停止等待"));
 await act(async()=>resolve());
 expect(api.run).not.toHaveBeenCalled();
});
it("polishes a selection and compares frozen original; candidate edits require confirmation",async()=>{
 const {container,patch}=await mount();await openAI(container);
 const field=container.querySelector<HTMLTextAreaElement>('[data-story-textarea]')!;
 await selectRange(field,3,6);await generate(container,"润色");
 expect(api.run.mock.calls[0][2]).toMatchObject({mode:"selection-polish",selectedText:"旧段落",sourceText:""});
 expect(container.querySelector('[data-story-candidate-original]')?.textContent).toBe("旧段落");
 expect(container.querySelector('[data-story-candidate-text]')?.textContent).toBe("新段落");
 expect(container.querySelector('[data-story-candidate-edit]')).toBeNull();
 await click(container.querySelector('[aria-label="编辑 AI 候选"]'));
 await typeText(container.querySelector<HTMLTextAreaElement>('[data-story-candidate-edit]')!,"取消的候选");
 expect((byText(container,"采用到草案") as HTMLButtonElement).disabled).toBe(true);
 await click(container.querySelector('[aria-label="AI 候选操作"] [data-drama-action="cancel"]'));
 expect(container.querySelector('[data-story-candidate-text]')?.textContent).toBe("新段落");
 await click(container.querySelector('[aria-label="编辑 AI 候选"]'));
 await typeText(container.querySelector<HTMLTextAreaElement>('[data-story-candidate-edit]')!,"人工修订");
 await click(container.querySelector('[aria-label="确认AI 候选"]'));
 expect(container.querySelector('[data-story-candidate-text]')?.textContent).toBe("人工修订");
 const writeText=vi.fn(async()=>{});
 const prev=Object.getOwnPropertyDescriptor(navigator,"clipboard");
 Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
 try{await click(container.querySelector('[aria-label="复制 AI 候选"]'));expect(writeText).toHaveBeenCalledWith("人工修订");}
 finally{if(prev)Object.defineProperty(navigator,"clipboard",prev);else Reflect.deleteProperty(navigator,"clipboard");}
 await click(byText(container,"采用到草案"));
 expect(field.value).toBe("开场\n人工修订\n结局");expect(patch).not.toHaveBeenCalled();
});
it("selects a collapsed caret or the explicit end for continuation",async()=>{
 const {container,patch}=await mount();await openAI(container);
 const field=container.querySelector<HTMLTextAreaElement>('[data-story-textarea]')!;
 await selectRange(field,3,3);await click(byText(container,"当前光标"));
 expect(container.querySelector('[data-story-ai-scope]')?.textContent).toContain("第 3 个字符");
 await generate(container);
 expect(api.run.mock.calls[0][2]).toMatchObject({mode:"continue",beforeText:"开场\n",afterText:"旧段落\n结局"});
 expect(container.querySelector('[data-story-candidate-original]')?.textContent).toContain("在此插入续写");
 await click(byText(container,"采用到草案"));
 expect(field.value).toBe("开场\n\n新段落\n\n旧段落\n结局");expect(patch).not.toHaveBeenCalled();
 await selectRange(field,0,2);await click(byText(container,"文末"));await generate(container);
 expect(api.run.mock.calls[1][2]).toMatchObject({mode:"continue",beforeText:field.value,afterText:""});
});
it("protects candidates from external saved text and linked source changes",async()=>{
 const {container,patch,updateSource,updateSources}=await mount();await openAI(container);await generate(container,"改写");
 await act(async()=>updateSources([{nodeId:"text",edgeId:"e",title:"上游",content:"新上游",digest:"new"}]));
 expect((byText(container,"采用到草案") as HTMLButtonElement).disabled).toBe(true);
 expect(container.querySelector('[data-story-candidate-original]')?.textContent).toBe(initial);
 await click(byText(container,"舍弃候选"));await generate(container,"润色");
 await act(async()=>updateSource("另一处已保存的正文"));
 expect((byText(container,"采用到草案") as HTMLButtonElement).disabled).toBe(true);
 expect(container.querySelector('[data-story-ai-candidate]')?.textContent).toContain("已过期");
 expect(patch).not.toHaveBeenCalled();
});
it("requires explicit resolution to collapse the panel",async()=>{
 const {container,patch,pending}=await mount();await openAI(container);await generate(container,"改写");
 await click(byText(container,"收起 AI 创作"));expect(container.textContent).toContain("收起面板前");
 await click(byText(container,"继续查看"));expect(container.querySelector('[data-story-ai-candidate]')).toBeTruthy();
 await click(byText(container,"收起 AI 创作"));await click(byText(container,"舍弃候选"));
 expect(container.querySelector('[aria-label="故事 AI 创作"]')).toBeNull();expect(pending.size).toBe(0);expect(patch).not.toHaveBeenCalled();
});
it("rejects oversize UTF-8 inputs before channel or model request, then permits a valid selection",async()=>{
 const {container}=await mount("字".repeat(7000));await openAI(container);await click(byText(container,"改写"));
 expect(container.textContent).toContain("全文超出");expect((byText(container,"生成候选") as HTMLButtonElement).disabled).toBe(true);
 expect(api.ensure).not.toHaveBeenCalled();expect(api.run).not.toHaveBeenCalled();
 const field=container.querySelector<HTMLTextAreaElement>('[data-story-textarea]')!;
 await selectRange(field,0,5000);expect(container.textContent).toContain("选区过长");
 await selectRange(field,0,2);await typeText(container.querySelector<HTMLTextAreaElement>('[aria-label="AI 写作要求"]')!,"字".repeat(1000));
 expect(container.textContent).toContain("补充写作要求过长");expect((byText(container,"生成候选") as HTMLButtonElement).disabled).toBe(true);
 await typeText(container.querySelector<HTMLTextAreaElement>('[aria-label="AI 写作要求"]')!,"");await generate(container);
 expect(api.run.mock.calls[0][2]).toMatchObject({mode:"selection",selectedText:"字字"});
});
it("never double-submits during channel sync and permits retry after an error",async()=>{
 let resolve:()=>void=()=>{};api.ensure.mockImplementationOnce(()=>new Promise<void>(r=>{resolve=r;}));api.run.mockRejectedValueOnce(Error("模型暂不可用"));
 const {container,patch}=await mount();await openAI(container);
 const button=byText(container,"生成候选") as HTMLButtonElement;
 await act(async()=>{button.click();button.click();});expect(api.ensure).toHaveBeenCalledTimes(1);expect(api.run).not.toHaveBeenCalled();
 await act(async()=>resolve());expect(container.textContent).toContain("模型暂不可用");
 expect(container.querySelector('[data-story-ai-candidate]')).toBeNull();await generate(container);
 expect(api.run).toHaveBeenCalledTimes(2);expect(container.querySelector('[data-story-ai-candidate]')).toBeTruthy();expect(patch).not.toHaveBeenCalled();
});
it("discards a late result after unmount and rejects an empty response",async()=>{
 api.run.mockResolvedValueOnce({candidate:" "});
 const {container,patch}=await mount();await openAI(container);await generate(container);
 expect(container.textContent).toContain("没有返回可用的文字");expect(container.querySelector('[data-story-ai-candidate]')).toBeNull();
 let resolve:(value:{candidate:string})=>void=()=>{};api.run.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 await generate(container);const root=roots.pop()!;
 await act(async()=>root.unmount());await act(async()=>resolve({candidate:"迟到"}));expect(patch).not.toHaveBeenCalled();
});
it("keeps a story draft mounted when art settings open and registers both independent changes",async()=>{
 const {container,patch,pending}=await mount();
 const body=container.querySelector<HTMLTextAreaElement>("[data-story-textarea]")!;
 await click(container.querySelector('[aria-label="编辑故事正文"]'));
 await typeText(body,"正文草案");
 await click(container.querySelector('[aria-label="展开美术设定"]'));
 expect(container.querySelector("[data-story-textarea]")).toBe(body);
 expect(body.value).toBe("正文草案");expect(body.readOnly).toBe(false);
 await click(container.querySelector('[aria-label="编辑影片风格"]'));
 await typeText(container.querySelector<HTMLTextAreaElement>('[aria-label="影片风格"]')!,"水彩风格");
 expect([...pending.keys()].sort()).toEqual(["story:story","story:story-art"]);
 expect(patch).not.toHaveBeenCalled();
 // Workspace save iterates these independently; neither update overwrites the other.
 for(const save of [...pending.values()])await act(async()=>{await save();});
 expect(patch.mock.calls).toEqual([[{dramaDraft:"正文草案",content:"正文草案"}],[{dramaFilmStyle:"水彩风格"}]]);
 expect(pending.size).toBe(0);
 await click(container.querySelector('[aria-label="收起美术设定"]'));
 expect(container.querySelector("[data-story-art-panel]")).toBeNull();
 expect(container.querySelector("[data-story-art-summary]")?.textContent).toContain("水彩风格");
 expect(body.value).toBe("正文草案");expect(body.readOnly).toBe(true);
});
it("disables generation for an empty story",async()=>{
 const {container}=await mount("  ");await openAI(container);
 expect(container.textContent).toContain("请先输入故事起始文字");expect((byText(container,"生成候选") as HTMLButtonElement).disabled).toBe(true);expect(api.ensure).not.toHaveBeenCalled();
});