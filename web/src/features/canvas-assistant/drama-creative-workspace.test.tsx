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
async function mount(kind:"source"|"assets"|"episodes"|"storyboard"="storyboard",withHistory=false,versionConfirmed=false){
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
   ["生成候选","浏览、编辑或删除生成候选，审核后采用到草案"],
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
  expect(boardTabs.map(tab=>tab.textContent?.trim())).toEqual(["镜头编辑","批量创建配置","生成候选","影响与历史"]);
  expect(boardTabs[0].getAttribute("aria-description")).toBe("编辑镜头内容、资产引用与单镜头视频配置");
  expect(boardTabs[1].getAttribute("aria-description")).toBe("批量创建视频配置及组建批量生成镜头组");
  expect(board.div.textContent).not.toContain("分页与单条 CAS");
 });
 it("opens assets in the shared workspace with distinct candidates and history tabs",async()=>{
  const {div,renderPanel}=await mount("assets",true);
  expect(div.querySelector('[data-drama-workspace-kind="assets"]')).toBeTruthy();
  const tabs=[...div.querySelectorAll<HTMLButtonElement>('nav[aria-label="创作工作区功能"] button')];
  expect(tabs.map(t=>t.textContent?.trim())).toEqual(["资产编辑","生成候选","影响与历史"]);
  expect(div.querySelector('[data-drama-workspace-title-row]')?.textContent).toContain("资产规划");
  await press(div,"生成候选");
  expect(renderPanel).toHaveBeenCalledWith("runs",expect.any(Function));
  await press(div,"影响与历史");
  expect(div.querySelector('[aria-label="测试内嵌历史"]')).toBeTruthy();
 });

 it("keeps asset pagination, selected identity and search across candidate and history tabs, and guards dirty edits",async()=>{
  const {DramaAssetWorkspaceFields}=await import("./drama-asset-workspace-fields");
  const {useState}=await import("react");
  type Asset=import("./canvas-drama-pipeline").DramaAsset;
  const initial:Asset[]=Array.from({length:13},(_,i)=>({id:"asset-"+(i+1),kind:"character",name:"角色 "+(i+1),description:"描述 "+(i+1),sourceRefs:[],aliases:["组别"],variants:[{id:"variant-"+(i+1),name:"造型",description:"描述"}]}));
  const div=document.createElement("div");document.body.append(div);
  const root=createRoot(div);roots.push(root);
  const changes=vi.fn();
  function Host(){
   const [assets,setAssets]=useState(initial);
   return <DramaCreativeWorkspace projectId="p1" nodeId="asset-node" kind="assets" focus={{}} versionConfirmed={false}
    onClose={async()=>{}} renderPanel={(tab,register)=>tab==="editor"?
     <DramaAssetWorkspaceFields key={tab} assets={assets} theme={canvasThemes.dark} disabled={false}
      onChange={next=>{changes(next);setAssets(next)}} onPendingChange={register}
      renderReferences={(_a,v)=><span data-test-reference={v}>已绑定参考图</span>}/>:
     <section>{tab}</section>} renderHistoryPanel={()=> <div>历史记录</div>}/>;
  }
  const click=async(label:string)=>{const b=div.querySelector<HTMLButtonElement>('button[aria-label="'+label+'"]');expect(b).toBeTruthy();await act(async()=>b!.click());};
  const input=async(label:string,value:string)=>{
   const el=div.querySelector<HTMLInputElement|HTMLTextAreaElement>('[aria-label="'+label+'"]')!;
   const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
   await act(async()=>{Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));});
  };
  await act(async()=>root.render(<Host/>));
  await input("搜索资产","组别");
  await click("资产下一页");
  await press(div,"角色 12");
  expect(div.querySelector('[data-test-reference="variant-12"]')).toBeTruthy();
  expect(div.querySelector<HTMLInputElement>('input[aria-label="搜索资产"]')?.value).toBe("组别");
  expect(div.querySelector('[data-asset-field]')).toBeTruthy();
  await press(div,"生成候选");await press(div,"影响与历史");await press(div,"资产编辑");
  expect(div.querySelector('[aria-label="当前资产编辑区"]')?.textContent).toContain("角色 12");
  expect(div.querySelector('aside')?.textContent).toContain("2/2");
  await click("编辑资产描述");await input("资产描述","未提交的修改");
  await press(div,"生成候选");
  expect(div.textContent).toContain("存在未提交的草案修改");
  expect(div.querySelector('[data-asset-workspace-view="editor"]')).toBeTruthy();
  await press(div,"继续编辑");
  expect(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="资产描述"]')?.value).toBe("未提交的修改");
  await press(div,"生成候选");await press(div,"放弃修改");
  expect(div.querySelector('[data-test-reference="variant-12"]')).toBeNull();
  expect(changes).not.toHaveBeenCalled();
  await press(div,"资产编辑");
  expect(div.querySelector('[data-test-reference="variant-12"]')).toBeTruthy();
  expect(div.querySelector('textarea[aria-label="资产描述"]')).toBeNull();
  expect(div.querySelector('[aria-label="当前资产编辑区"]')?.textContent).toContain("描述 12");
  await click("编辑资产描述");await input("资产描述","确认后的描述");
  await press(div,"生成候选");await press(div,"保存草案");
  expect(changes).toHaveBeenCalledTimes(1);
  expect(div.querySelector('[data-test-reference="variant-12"]')).toBeNull();
  await press(div,"资产编辑");
  expect(div.querySelector('[aria-label="当前资产编辑区"]')?.textContent).toContain("确认后的描述");
  expect(div.querySelector<HTMLInputElement>('input[aria-label="搜索资产"]')?.value).toBe("组别");
 });
 it("places pending actions in the tab row and saves or discards in place without navigating",async()=>{
  const {useState,useEffect}=await import("react");
  type Register=import("./drama-creative-workspace").WorkspacePendingRegistration;
  const div=document.createElement("div");document.body.append(div);const root=createRoot(div);roots.push(root);
  const changes=vi.fn();const navigate=vi.fn();let fail=false;
  function Editor({register,value,onSave}:{register:Register;value:string;onSave:(value:string)=>void}){
   const [draft,setDraft]=useState(value);
   useEffect(()=>{
    register("draft",draft!==value?async()=>{if(fail)throw Error("版本冲突");onSave(draft);}:null);
    return ()=>register("draft",null);
   },[register,draft,value,onSave]);
   return <input aria-label="测试修改" value={draft} onChange={e=>setDraft(e.target.value)}/>;
  }
  function Host(){
   const [value,setValue]=useState("原内容");
   return <DramaCreativeWorkspace projectId="p1" nodeId="pending-node" kind="episodes" focus={{}} versionConfirmed={true}
    onClose={async()=>{}} onTabChange={navigate} renderPanel={(_tab,register)=><Editor register={register} value={value} onSave={next=>{changes(next);setValue(next);}}/>}/>;
  }
  await act(async()=>root.render(<Host/>));
  await press(div,"生成候选");
  navigate.mockClear();
  const workspace=div.querySelector('[data-creative-workspace-node-id="pending-node"]')!;
  const row=workspace.querySelector("[data-drama-workspace-tab-row]")!;
  const edit=async(value:string)=>{
   const input=workspace.querySelector<HTMLInputElement>('[aria-label="测试修改"]')!;
   await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
  };
  await edit("未保存内容");
  const chip=row.querySelector<HTMLButtonElement>('[aria-label="1 处未保存"]')!;
  expect(chip).toBeTruthy();expect(chip.title).toContain("局部候选修改");
  expect(chip.closest("[data-drama-pending-status]")?.parentElement).toBe(row);
  expect(workspace.querySelectorAll('[role="status"]')).toHaveLength(1);
  await press(div,"1 处未保存");
  expect(row.querySelector('[data-drama-pending-menu]')?.textContent).toContain("局部候选修改");
  await press(div,"继续编辑");
  expect(row.querySelector('[data-drama-pending-menu]')).toBeNull();
  expect(workspace.querySelector<HTMLInputElement>('[aria-label="测试修改"]')?.value).toBe("未保存内容");
  await press(div,"1 处未保存");
  fail=true;await press(div,"保存候选");
  expect(row.querySelector('[role="alert"]')?.textContent).toBe("版本冲突");
  expect(workspace.querySelector<HTMLInputElement>('[aria-label="测试修改"]')?.value).toBe("未保存内容");
  expect(changes).not.toHaveBeenCalled();
  fail=false;await press(div,"保存候选");
  expect(changes).toHaveBeenCalledWith("未保存内容");
  expect(row.querySelector('[data-drama-pending-status]')).toBeNull();
  await edit("放弃的内容");await press(div,"1 处未保存");await press(div,"放弃修改");
  expect(workspace.querySelector<HTMLInputElement>('[aria-label="测试修改"]')?.value).toBe("未保存内容");
  expect(row.querySelector('[data-drama-pending-status]')).toBeNull();
  expect(changes).toHaveBeenCalledTimes(1);expect(navigate).not.toHaveBeenCalled();
  expect(row.querySelector('nav button[aria-pressed="true"]')?.textContent).toBe("生成候选");
 });


 it("shows the candidate count and prevents close or tab changes while an adoption is in progress",async()=>{
  const {useContext}=await import("react");
  const {AssetReviewBusyContext,AssetReviewNavigationContext}=await import("./drama-asset-directory-state");
  const div=document.createElement("div");document.body.append(div);const root=createRoot(div);roots.push(root);
  const close=vi.fn(async()=>{});
  function Review(){
   const busy=useContext(AssetReviewBusyContext);
   const navigate=useContext(AssetReviewNavigationContext);
   return <><button onClick={()=>busy?.(true)}>开始合入</button>
    <button onClick={()=>{navigate?.();busy?.(false)}}>合入完成</button></>;
  }
  await act(async()=>root.render(<DramaCreativeWorkspace projectId="p1" nodeId="assets" kind="assets" focus={{}} versionConfirmed={false}
   candidateCount={12} onClose={close} renderPanel={tab=>tab==="runs"?<Review/>:<span data-current-tab={tab}>{tab}</span>}/>));
  await press(div,"生成候选 · 12");await press(div,"开始合入");
  expect(div.textContent).toContain("正在合入资产");
  await press(div,"资产编辑");
  expect(div.textContent).toContain("开始合入");
  await act(async()=>div.querySelector<HTMLButtonElement>('[aria-label="关闭工作区对话框"]')?.click());
  expect(close).not.toHaveBeenCalled();
  await press(div,"合入完成");
  expect(div.querySelector('[data-current-tab="editor"]')).toBeTruthy();
  expect(div.textContent).not.toContain("正在合入资产");
 });
 it("opens a unified source workspace with story and history tabs; art settings belong to the editor",async()=>{
  const story=await mount("source",true);
  const tabs=[...story.div.querySelectorAll<HTMLButtonElement>('nav[aria-label="创作工作区功能"] button')];
  expect(tabs.map(tab=>tab.textContent?.trim())).toEqual(["故事正文","影响与历史"]);
  expect(story.div.querySelector('[data-drama-workspace-title-row]')?.textContent).toContain("故事");
  expect(tabs[0].getAttribute("aria-description")).toContain("选区改写");
  expect(tabs[0].getAttribute("aria-description")).toContain("美术风格");
  expect(story.renderPanel).toHaveBeenCalledWith("editor",expect.any(Function));
  await press(story.div,"影响与历史");
  expect(story.div.querySelector('[aria-label="测试内嵌历史"]')).toBeTruthy();
 });
 it("saves story fields before version confirmation and leaves failed edits pending",async()=>{
  const {useEffect}=await import("react");
  const div=document.createElement("div");document.body.append(div);const root=createRoot(div);roots.push(root);
  const order:string[]=[];let fail=true;
  const confirm=vi.fn(async()=>{order.push("confirm");});
  function Story({register}:{register:import("./drama-creative-workspace").WorkspacePendingRegistration}){
   useEffect(()=>{register("story:story",async()=>{order.push("save");if(fail)throw Error("草案未落盘");register("story:story",null);});
    return ()=>register("story:story",null);},[register]);
   return <div>正文草案</div>;
  }
  await act(async()=>root.render(<DramaCreativeWorkspace projectId="p1" nodeId="story" kind="source" focus={{}} versionConfirmed={false}
   storyVersionAction={{hasText:true,busy:false,confirm}} onClose={async()=>{}} renderPanel={(_tab,register)=><Story register={register}/>}/>));
  expect(div.querySelectorAll('[data-story-confirm-version]')).toHaveLength(1);
  await press(div,"保存并确认故事版本");
  expect(order).toEqual(["save"]);expect(confirm).not.toHaveBeenCalled();
  expect(div.textContent).toContain("草案未落盘");
  expect(div.querySelector('[data-drama-pending-status]')).toBeTruthy();
  fail=false;await press(div,"保存并确认故事版本");
  expect(order).toEqual(["save","save","confirm"]);
  expect(div.querySelector('[data-drama-pending-status]')).toBeNull();
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
  expect(renderPanel).toHaveBeenCalledWith("editor",expect.any(Function));
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
