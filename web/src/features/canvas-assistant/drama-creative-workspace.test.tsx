// @vitest-environment happy-dom
import {act,useEffect,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
const stats=vi.hoisted(()=>({save:vi.fn(async()=>{}),browserMount:vi.fn()}));
vi.mock("antd",()=>({
 Modal:({open,children,title,onCancel,styles}:{open:boolean;children:React.ReactNode;title:React.ReactNode;onCancel:()=>void;styles?:{container?:React.CSSProperties;body?:React.CSSProperties}})=>
  open?<div role="dialog" style={styles?.container}><header>{title}<button aria-label="关闭工作区对话框" onClick={onCancel}>关闭</button></header><div data-test-modal-body="" style={styles?.body}>{children}</div></div>:null,
}));
vi.mock("./drama-revision-browser",()=>({
 DramaRevisionBrowser:({onPendingChange,initialShotId}:{onPendingChange:(key:string,save:(()=>Promise<void>)|null)=>void;initialShotId?:string})=>{
  const [dirty,setDirty]=useState(false);
  useEffect(()=>{stats.browserMount(initialShotId);},[initialShotId]);
  useEffect(()=>{
   onPendingChange("shot-1",dirty?stats.save:null);
   return ()=>onPendingChange("shot-1",null);
  },[dirty,onPendingChange]);
  return <section aria-label="镜头分页表单"><button onClick={()=>setDirty(true)}>修改局部草案</button></section>;
 }
}));
vi.mock("./drama-creative-scope-browser",()=>({
 DramaCreativeScopeBrowser:()=> <div aria-label="剧集分页表单">剧集按页读取</div>
}));
import {DramaCreativeWorkspace} from "./drama-creative-workspace";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
const roots:Root[]=[];
beforeEach(()=>{stats.save.mockReset();stats.browserMount.mockReset();vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true)});
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;vi.unstubAllGlobals()});
async function mount(kind:"episodes"|"storyboard"="storyboard"){
 const div=document.createElement("div");document.body.append(div);
 const root=createRoot(div);roots.push(root);
 const close=vi.fn(async()=>{});
 const renderPanel=vi.fn(tab=><section aria-label="完整编辑器内容">{tab}</section>);
 await act(async()=>root.render(<DramaCreativeWorkspace projectId="p1" nodeId={kind==="episodes"?"episodes":"board"} kind={kind}
  focus={{episodeId:"ep-two",shotId:"shot-2"}} color={{fill:"#fff",text:"#000",muted:"#888"}}
  onClose={close} renderPanel={renderPanel}/>));
 return {div,close,renderPanel};
}
async function press(div:HTMLElement,label:string){
 const button=[...div.querySelectorAll("button")].find(b=>b.textContent?.trim()===label);
 expect(button, "button "+label).toBeTruthy();
 await act(async()=>{button!.click();await Promise.resolve();});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
}
describe("P3.4b3 workspace lifecycle",()=>{
 it("uses canvas theme tokens and keeps the same active tab when theme changes",async()=>{
  const {div,renderPanel}=await mount("episodes");
  const root=div.querySelector<HTMLElement>('[data-creative-workspace-node-id="episodes"]')!;
  const modal=div.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(root.dataset.dramaWorkspaceTheme).toBe("dark");
  expect(modal.style.background).toBe(canvasThemes.dark.node.fill);
  expect(root.querySelectorAll('nav[aria-label="创作工作区功能"] button')).toHaveLength(4);
  const active=()=>root.querySelector<HTMLButtonElement>('nav button[aria-pressed="true"]')?.textContent;
  expect(active()).toBe("剧集编辑");
  await act(async()=>{useThemeStore.setState({theme:"light"});});
  expect(root.dataset.dramaWorkspaceTheme).toBe("light");
  expect(modal.style.background).toBe(canvasThemes.light.node.fill);
  expect(active()).toBe("剧集编辑");
  await press(div,"分页与单条 CAS");
  expect(active()).toBe("分页与单条 CAS");
  await act(async()=>{useThemeStore.setState({theme:"dark"});});
  expect(active()).toBe("分页与单条 CAS");
  expect(renderPanel).toHaveBeenCalledWith("editor");
 });
 it("mounts scoped browser only on its tab and passes exact shot selection",async()=>{
  const {div}=await mount();
  expect(div.textContent).toContain("editor");
  expect(stats.browserMount).not.toHaveBeenCalled();
  await press(div,"分页与单条 CAS");
  expect(div.querySelector('[aria-label="镜头分页表单"]')).toBeTruthy();
  expect(stats.browserMount).toHaveBeenCalledWith("shot-2");
  expect(div.querySelector('[aria-label="完整编辑器内容"]')).toBeNull();
 });
 it("gates tab changes and saves local CAS draft before closing",async()=>{
  const {div,close}=await mount();
  await press(div,"分页与单条 CAS");
  await press(div,"修改局部草案");
  await press(div,"生成候选");
  expect(div.textContent).toContain("存在未提交的草案修改");
  await press(div,"继续编辑");
  expect(div.querySelector('[aria-label="镜头分页表单"]')).toBeTruthy();
  await press(div,"生成候选");
  await press(div,"保存草案");
  expect(stats.save).toHaveBeenCalledTimes(1);
  expect(div.querySelector('[aria-label="完整编辑器内容"]')?.textContent).toBe("runs");
  await act(async()=>{div.querySelector<HTMLButtonElement>('[aria-label="关闭工作区对话框"]')?.click();});
  expect(close).toHaveBeenCalledTimes(1);
 });
 it("does not leave the form when CAS save rejects a stale digest",async()=>{
  stats.save.mockRejectedValueOnce(new Error("expectedDigest 已过期"));
  const {div,close}=await mount();
  await press(div,"分页与单条 CAS");
  await press(div,"修改局部草案");
  await press(div,"生成候选");
  await press(div,"保存草案");
  expect(div.textContent).toContain("expectedDigest 已过期");
  expect(div.querySelector('[aria-label="镜头分页表单"]')).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  await press(div,"继续编辑");
 });
});
