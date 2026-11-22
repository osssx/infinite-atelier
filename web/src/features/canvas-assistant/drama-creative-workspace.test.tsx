// @vitest-environment happy-dom
import {act,useEffect,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
const stats=vi.hoisted(()=>({save:vi.fn(async()=>{}),browserMount:vi.fn()}));
vi.mock("antd",()=>({
 ConfigProvider:({children}:{children:React.ReactNode})=><>{children}</>,
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
async function mount(kind:"episodes"|"storyboard"="storyboard",withHistory=false){
 const div=document.createElement("div");document.body.append(div);
 const root=createRoot(div);roots.push(root);
 const close=vi.fn(async()=>{});
 const onTabChange=vi.fn();
 const renderPanel=vi.fn(tab=><section aria-label="完整编辑器内容">{tab}</section>);
 await act(async()=>root.render(<DramaCreativeWorkspace projectId="p1" nodeId={kind==="episodes"?"episodes":"board"} kind={kind}
  focus={{episodeId:"ep-two",shotId:"shot-2"}} color={{fill:"#fff",text:"#000",muted:"#888"}}
  onClose={close} onTabChange={onTabChange} renderPanel={renderPanel}
  renderHistoryPanel={withHistory?()=> <section aria-label="测试内嵌历史">历史预览</section>:undefined}/>));
 return {div,close,renderPanel,onTabChange};
}
async function press(div:HTMLElement,label:string){
 const button=[...div.querySelectorAll("button")].find(b=>b.textContent?.trim()===label);
 expect(button, "button "+label).toBeTruthy();
 await act(async()=>{button!.click();await Promise.resolve();});
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
}
describe("P3.4b3 workspace lifecycle",()=>{
 it("renders tab descriptions only as tooltip triggers",async()=>{
  const episode=await mount("episodes");
  const workspace=episode.div.querySelector('[data-creative-workspace-node-id="episodes"]')!;
  const expected=[
   ["剧集编辑","按集编辑剧情、事件、场次及来源引用"],
   ["分页与单条 CAS","按页读取、精准保存和批量提交草案"],
   ["生成候选","按运行状态浏览候选，展开查看内容与采用选项"],
   ["影响与历史","版本快照与上游影响直接在工作区内查看"],
  ];
  const tabs=[...workspace.querySelectorAll<HTMLButtonElement>('nav[aria-label="创作工作区功能"] button')];
  expect(tabs).toHaveLength(expected.length);
  for(const [index,[label,description]] of expected.entries()){
   expect(tabs[index].textContent?.trim()).toBe(label);
   expect(tabs[index].getAttribute("aria-description")).toBe(description);
     }
  await act(async()=>{tabs[3].focus();});
   expect(document.querySelector('[data-drama-tab-tooltip="history"]')?.textContent).toBe(expected[3][1]);
   await act(async()=>{tabs[3].blur();});
   expect(document.querySelector('[data-drama-tab-tooltip="history"]')).toBeNull();
   expect(workspace.textContent).not.toContain("按页读取、精准保存和批量提交草案");
  expect(workspace.querySelector('[role="status"]')).toBeNull();

  const board=await mount("storyboard");
  const boardTabs=[...board.div.querySelectorAll<HTMLButtonElement>('nav[aria-label="创作工作区功能"] button')];
  expect(boardTabs).toHaveLength(5);
  expect(boardTabs[0].getAttribute("aria-description")).toBe("检查分镜结构与镜头安排");
  expect(boardTabs[2].getAttribute("aria-description")).toBe("按镜头配置独立的视频生成参数");
  await press(board.div,"分页与单条 CAS");
  await press(board.div,"修改局部草案");
  expect(board.div.querySelector('[role="status"]')?.textContent).toContain("1 组尚未保存");
 });
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
 it("renders inline history only in its tab and clears it on exit",async()=>{
  const {div,onTabChange}=await mount("episodes",true);
  expect(div.querySelector('[aria-label="测试内嵌历史"]')).toBeNull();
  await press(div,"影响与历史");
  expect(div.querySelector('[data-drama-history-layout]')).toBeTruthy();
  expect(div.querySelector('[aria-label="历史版本面板"] [aria-label="测试内嵌历史"]')).toBeTruthy();
  expect(div.querySelector('[aria-label="上游影响面板"]')).toBeTruthy();
  const sections=[...div.querySelectorAll<HTMLElement>('[data-drama-history-layout] > section')];
  expect(sections.map(section=>section.getAttribute("aria-label"))).toEqual(["上游影响面板","历史版本面板"]);
  const scroll=sections[0].querySelector<HTMLElement>("[data-drama-impact-scroll]");
  expect(scroll?.classList.contains("max-h-full")).toBe(true);
  expect(scroll?.classList.contains("overflow-y-auto")).toBe(true);
  expect(scroll?.style.scrollbarGutter).toBe("auto");
  expect(sections[1].querySelector('[data-drama-history-fill]')).toBeTruthy();
  expect(onTabChange).toHaveBeenCalledWith("history");
  await act(async()=>useThemeStore.setState({theme:"light"}));
  expect(div.querySelector('[aria-label="测试内嵌历史"]')).toBeTruthy();
  await press(div,"生成候选");
  expect(div.querySelector('[aria-label="测试内嵌历史"]')).toBeNull();
  expect(onTabChange).toHaveBeenCalledWith("runs");
 });
 it("blocks history loading while a local CAS draft is dirty",async()=>{
  const {div,onTabChange}=await mount("storyboard",true);
  await press(div,"分页与单条 CAS");
  await press(div,"修改局部草案");
  onTabChange.mockClear();
  await press(div,"影响与历史");
  expect(div.textContent).toContain("存在未提交的草案修改");
  expect(onTabChange).not.toHaveBeenCalled();
  expect(div.querySelector('[aria-label="测试内嵌历史"]')).toBeNull();
  await press(div,"继续编辑");
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
