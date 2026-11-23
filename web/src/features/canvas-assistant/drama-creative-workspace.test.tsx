// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("antd",()=>({
 ConfigProvider:({children}:{children:React.ReactNode})=><>{children}</>,
 Modal:({open,children,title,onCancel,styles}:{open:boolean;children:React.ReactNode;title:React.ReactNode;onCancel:()=>void;styles?:{container?:React.CSSProperties;body?:React.CSSProperties}})=>
  open?<div role="dialog" style={styles?.container}><header>{title}<button aria-label="关闭工作区对话框" onClick={onCancel}>关闭</button></header><div data-test-modal-body="" style={styles?.body}>{children}</div></div>:null,
}));
import {DramaCreativeWorkspace} from "./drama-creative-workspace";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;vi.unstubAllGlobals()});
async function mount(kind:"episodes"|"storyboard"="storyboard",withHistory=false,versionConfirmed=false){
 const div=document.createElement("div");document.body.append(div);
 const root=createRoot(div);roots.push(root);
 const close=vi.fn(async()=>{});
 const onTabChange=vi.fn();
 const renderPanel=vi.fn(tab=><section aria-label="完整编辑器内容">{tab}</section>);
 await act(async()=>root.render(<DramaCreativeWorkspace projectId="p1" nodeId={kind==="episodes"?"episodes":"board"} kind={kind}
  focus={{episodeId:"ep-two",shotId:"shot-2"}} versionConfirmed={versionConfirmed}
  color={{fill:"#fff",text:"#000",muted:"#888"}}
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
   ["生成候选","按运行状态浏览候选，展开查看内容与采用选项"],
   ["影响与历史","版本快照与上游影响直接在工作区内查看"],
  ];
  const tabs=[...workspace.querySelectorAll<HTMLButtonElement>('nav[aria-label="创作工作区功能"] button')];
  expect(tabs).toHaveLength(expected.length);
  for(const [index,[label,description]] of expected.entries()){
   expect(tabs[index].textContent?.trim()).toBe(label);
   expect(tabs[index].getAttribute("aria-description")).toBe(description);
     }
  await act(async()=>{tabs[2].focus();});
   expect(document.activeElement).toBe(tabs[2]);
   expect(document.querySelector('[data-drama-tab-tooltip="history"]')).toBeNull();
   await act(async()=>{tabs[2].dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));});
   expect(document.querySelector('[data-drama-tab-tooltip="history"]')?.textContent).toBe(expected[2][1]);
   await act(async()=>{tabs[2].dispatchEvent(new MouseEvent("mouseout",{bubbles:true}));});
   expect(document.querySelector('[data-drama-tab-tooltip="history"]')).toBeNull();
   expect(document.activeElement).toBe(tabs[2]);
   expect(workspace.textContent).not.toContain("按页读取、精准保存和批量提交草案");
  expect(workspace.querySelector('[role="status"]')).toBeNull();

  const board=await mount("storyboard");
  const boardTabs=[...board.div.querySelectorAll<HTMLButtonElement>('nav[aria-label="创作工作区功能"] button')];
  expect(boardTabs).toHaveLength(4);
  expect(boardTabs.map(tab=>tab.textContent?.trim())).toEqual(["分镜表","视频配置","生成候选","影响与历史"]);
  expect(boardTabs[0].getAttribute("aria-description")).toBe("检查分镜结构与镜头安排");
  expect(boardTabs[1].getAttribute("aria-description")).toBe("按镜头配置独立的视频生成参数");
  expect(board.div.textContent).not.toContain("分页与单条 CAS");
 });
 it("places the draft or confirmed state beside the workspace title instead of a separate row",async()=>{
  const draft=await mount("episodes");
  const root=draft.div.querySelector<HTMLElement>('[data-creative-workspace-node-id="episodes"]')!;
  const header=draft.div.querySelector<HTMLElement>('[data-drama-workspace-title]')!;
  const titleRow=header.querySelector<HTMLElement>('[data-drama-workspace-title-row]')!;
  expect(titleRow.textContent).toContain("剧集规划");
  expect(titleRow.querySelector('[data-drama-workspace-version-status]')?.textContent).toBe("草案");
  expect(draft.div.querySelectorAll('[data-drama-workspace-version-status]')).toHaveLength(1);
  expect(root.querySelector('[data-drama-workspace-version-status]')).toBeNull();
  const confirmed=await mount("storyboard",false,true);
  const other=confirmed.div.querySelector<HTMLElement>('[data-drama-workspace-title-row]')!;
  expect(other.textContent).toContain("分镜配置");
  expect(other.querySelector('[data-drama-workspace-version-status]')?.textContent).toBe("已确认");
 });
 it("uses canvas theme tokens and keeps the same active tab when theme changes",async()=>{
  const {div,renderPanel}=await mount("episodes");
  const root=div.querySelector<HTMLElement>('[data-creative-workspace-node-id="episodes"]')!;
  const modal=div.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(root.dataset.dramaWorkspaceTheme).toBe("dark");
  expect(modal.style.background).toBe(canvasThemes.dark.node.fill);
  expect(root.querySelectorAll('nav[aria-label="创作工作区功能"] button')).toHaveLength(3);
  const active=()=>root.querySelector<HTMLButtonElement>('nav button[aria-pressed="true"]')?.textContent;
  expect(active()).toBe("剧集编辑");
  await act(async()=>{useThemeStore.setState({theme:"light"});});
  expect(root.dataset.dramaWorkspaceTheme).toBe("light");
  expect(modal.style.background).toBe(canvasThemes.light.node.fill);
  expect(active()).toBe("剧集编辑");
  await press(div,"生成候选");
  expect(active()).toBe("生成候选");
  await act(async()=>{useThemeStore.setState({theme:"dark"});});
  expect(active()).toBe("生成候选");
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
 it("uses the same three work tabs for episodes with no duplicate CAS editor",async()=>{
  const episodes=await mount("episodes");
  const tabs=[...episodes.div.querySelectorAll<HTMLButtonElement>('nav[aria-label="创作工作区功能"] button')];
  expect(tabs.map(tab=>tab.textContent?.trim())).toEqual(["剧集编辑","生成候选","影响与历史"]);
  expect(episodes.div.textContent).not.toContain("分页与单条 CAS");
  await press(episodes.div,"生成候选");
  expect(episodes.div.querySelector('[aria-label="完整编辑器内容"]')?.textContent).toBe("runs");
  await press(episodes.div,"剧集编辑");
  expect(episodes.div.querySelector('[aria-label="完整编辑器内容"]')?.textContent).toBe("editor");
 });
 it("keeps normal episode history navigation and close actions after removing the redundant tab",async()=>{
  const {div,close,onTabChange}=await mount("episodes",true);
  await press(div,"影响与历史");
  expect(div.querySelector('[aria-label="测试内嵌历史"]')).toBeTruthy();
  expect(onTabChange).toHaveBeenCalledWith("history");
  await press(div,"剧集编辑");
  await act(async()=>{div.querySelector<HTMLButtonElement>('[aria-label="关闭工作区对话框"]')?.click();});
  expect(close).toHaveBeenCalledTimes(1);
 });
});
