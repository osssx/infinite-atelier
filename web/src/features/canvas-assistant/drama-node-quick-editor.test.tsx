// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
const evidence=vi.hoisted(()=>({
 requests:[] as {path:string;method:string;body:Record<string,unknown>}[],
 options:[] as Record<string,unknown>[],
 rejectNext:false
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({
 canvasApi:vi.fn(async(path:string,method:string,body:Record<string,unknown>)=>{
  evidence.requests.push({path,method,body});
  if(evidence.rejectNext){evidence.rejectNext=false;throw Error("drama_candidate_conflict");}
  return {id:"p1",revision:2,document:{nodes:[],connections:[]}};
 })
}));
vi.mock("@/stores/canvas/use-canvas-store",()=>({
 commitAssistantCanvasGraphWithSaveBarrier:vi.fn(async(projectId:string,
  submit:(ctx:{assertCurrent:()=>void})=>Promise<unknown>,options:Record<string,unknown>)=>{
  expect(projectId).toBe("p1");
  evidence.options.push(options);
  return submit({assertCurrent:()=>{}});
 })
}));
import {DramaNodeQuickEditor} from "./drama-node-quick-editor";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
const roots:Root[]=[];
beforeEach(()=>{evidence.requests=[];evidence.options=[];evidence.rejectNext=false;
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true)});
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());
 roots.length=0;vi.unstubAllGlobals()});
async function mount(kind:"episodes"|"storyboard",entry:Record<string,unknown>){
 const el=document.createElement("div");document.body.append(el);
 const root=createRoot(el);roots.push(root);
 const saved=vi.fn(),cancel=vi.fn(),reload=vi.fn();
 async function render(value=entry,digest="a".repeat(64)){
  await act(async()=>root.render(<DramaNodeQuickEditor projectId="p1" nodeId={kind==="episodes"?"episodes":"board"}
   kind={kind} entry={value} expectedDigest={digest} onSaved={saved} onCancel={cancel} onReload={reload}/>));
 }
 await render();
 return {el,render,saved,cancel,reload};
}
async function change(el:HTMLElement,label:string,value:string){
 const input=el.querySelector<HTMLInputElement|HTMLTextAreaElement>('[aria-label="'+label+'"]')!;
 expect(input).toBeTruthy();
 await act(async()=>{
  const setter=Object.getOwnPropertyDescriptor(input.tagName==="INPUT"?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,"value")!.set!;
  setter.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));
 });
}
async function click(el:HTMLElement,text:string){
 const btn=[...el.querySelectorAll("button")].find(b=>b.textContent?.trim()===text)!;
 expect(btn).toBeTruthy();
 await act(async()=>{btn.click();await Promise.resolve();});
 await act(async()=>{await new Promise(r=>setTimeout(r,12));});
}
describe("P3.4b4 indexed quick editing",()=>{
 it("only patches selected episode fields, with digest, operation ID and save barrier",async()=>{
  const {el,saved}=await mount("episodes",{id:"ep-one",title:"第一集",synopsis:"出发前夜"});
  expect(evidence.requests).toHaveLength(0);
  await change(el,"快速编辑集标题","新的第一集");
  expect(evidence.requests).toHaveLength(0);
  await click(el,"保存草案");
  expect(saved).toHaveBeenCalledTimes(1);
  expect(evidence.requests).toHaveLength(1);
  expect(evidence.requests[0].path).toContain("/entry-draft");
  expect(evidence.requests[0].body).toMatchObject({
   kind:"episodes",nodeId:"episodes",entryId:"ep-one",expectedDigest:"a".repeat(64),
   changes:{title:"新的第一集"}
  });
  expect(evidence.requests[0].body).not.toHaveProperty("dramaDraft");
  expect(evidence.requests[0].body.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(evidence.options[0]).toMatchObject({keepCreativePointers:true,invalidateCreativeNodeId:"episodes"});
 });
 it("shot save is narrow and never changes other shots or media configuration",async()=>{
  const {el,saved}=await mount("storyboard",{id:"shot-2",episodeId:"ep-two",description:"旧画面",durationSec:5});
  await change(el,"快速编辑画面描述","主角慢慢进入画面");
  await change(el,"快速编辑镜头时长","6.5");
  expect(el.querySelector<HTMLInputElement>('[aria-label="快速编辑镜头时长"]')!.value).toBe("6.5");
  expect(el.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(el.querySelector<HTMLFormElement>("form")!.checkValidity()).toBe(true);
  await click(el,"保存草案");
  expect(saved).toHaveBeenCalledTimes(1);
  expect(evidence.requests).toHaveLength(1);
  expect(evidence.requests[0].path).toContain("/shot-draft");
  expect(evidence.requests[0].body).toMatchObject({
   nodeId:"board",shotId:"shot-2",expectedDigest:"a".repeat(64),
   changes:{description:"主角慢慢进入画面",durationSec:6.5}
  });
  expect(Object.keys(evidence.requests[0].body.changes as object)).toEqual(["description","durationSec"]);
 });
 it("conflicts preserve text and the original digest; only explicit reload discards it",async()=>{
  const original={id:"ep-one",title:"原题",synopsis:"原概要"};
  const {el,render,saved,reload}=await mount("episodes",original);
  await change(el,"快速编辑剧情概要","我尚未提交的剧情");
  await render({...original,synopsis:"其他人已提交"}, "b".repeat(64));
  evidence.rejectNext=true;
  await click(el,"保存草案");
  expect(saved).not.toHaveBeenCalled();
  expect(el.querySelector<HTMLTextAreaElement>('[aria-label="快速编辑剧情概要"]')!.value).toBe("我尚未提交的剧情");
  expect(el.textContent).toContain("未覆盖任何内容");
  expect(evidence.requests[0].body.expectedDigest).toBe("a".repeat(64));
  await click(el,"重新读取最新草案（放弃本次输入）");
  expect(reload).toHaveBeenCalledTimes(1);
 });
 it("uses canvas theme colors, fixed action footer and local dirty state",async()=>{
  const {el}=await mount("episodes",{id:"ep-one",title:"原题",synopsis:"原概要"});
  const editor=el.querySelector<HTMLElement>('[aria-label="剧集快速编辑"]')!;
  const input=el.querySelector<HTMLInputElement>('[aria-label="快速编辑集标题"]')!;
  const footer=editor.querySelector("footer")!;
  expect(footer.querySelectorAll("button")).toHaveLength(2);
  await act(async()=>useThemeStore.setState({theme:"light"}));
  expect(editor.dataset.dramaEditorTheme).toBe("light");
  expect(input.style.background).toBe(canvasThemes.light.node.fill);
  await act(async()=>useThemeStore.setState({theme:"dark"}));
  expect(editor.dataset.dramaEditorTheme).toBe("dark");
  expect(input.style.background).toBe(canvasThemes.dark.node.fill);
  await change(el,"快速编辑剧情概要","修改后只保存在表单状态");
  expect(el.textContent).toContain("有未保存修改");
  expect(footer.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  expect(evidence.requests).toHaveLength(0);
 });
 it("cancel and an unchanged form do not write",async()=>{
  const {el,cancel}=await mount("episodes",{id:"ep-one",title:"原题",synopsis:"原概要"});
  const save=el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(save.disabled).toBe(true);
  await click(el,"取消");
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(evidence.requests).toHaveLength(0);
 });
});
