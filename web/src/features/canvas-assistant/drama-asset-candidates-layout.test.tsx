// @vitest-environment happy-dom
import {act} from "react";
import type {CSSProperties,ReactNode} from "react";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {DramaAsset} from "./canvas-drama-pipeline";
import type {AssetDecision} from "./drama-asset-merge";

vi.mock("antd",()=>({
 Button:({children,disabled,onClick,style,className}:{children:ReactNode;disabled?:boolean;onClick?:()=>void;style?:CSSProperties;className?:string})=>
  <button type="button" disabled={disabled} onClick={onClick} style={style} className={className}>{children}</button>
}));
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"light"}))
}));
import {DramaAssetCandidates} from "./drama-asset-candidates";

const roots:Root[]=[];
const candidates:DramaAsset[]=Array.from({length:12},(_,index)=>({
 id:"candidate-"+(index+1),kind:"character",name:"候选 "+(index+1),
 description:"一段较长的角色形象描述。".repeat(15),sourceRefs:[]
}));
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);useThemeStore.setState({theme:"light"});});
afterEach(async()=>{
 for(const root of roots)await act(async()=>root.unmount());
 roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();
});
async function mount(disabled=false,applyImpl?:(decisions:Record<string,AssetDecision>)=>Promise<void>|void,assets:DramaAsset[]=[]){
 const div=document.createElement("div");document.body.append(div);
 const root=createRoot(div);roots.push(root);
 const apply=vi.fn(applyImpl??(()=>{})),discard=vi.fn(),parentWheel=vi.fn(),parentPointer=vi.fn();
 await act(async()=>root.render(<div onWheel={parentWheel} onPointerDown={parentPointer}>
  <DramaAssetCandidates assets={assets} candidates={candidates}
   disabled={disabled} onApply={apply} onDiscard={discard}/>
 </div>));
 return {div,apply,discard,parentWheel,parentPointer};
}
it("keeps the header and actions outside a bounded, keyboard-scrollable candidate region",async()=>{
 const {div,apply}=await mount();
 const details=div.querySelector<HTMLDetailsElement>("details")!;
 const scroll=div.querySelector<HTMLElement>('[data-asset-candidate-scroll-region]')!;
 expect(details.open).toBe(true);
 expect(scroll).toBeTruthy();
 expect(scroll.getAttribute("role")).toBe("region");
 expect(scroll.getAttribute("aria-label")).toBe("待审核资产候选列表");
 expect(scroll.tabIndex).toBe(0);
 expect(scroll.classList.contains("overflow-y-auto")).toBe(true);
 expect(scroll.classList.contains("overscroll-contain")).toBe(true);
 expect(scroll.style.maxHeight).toBe("min(42vh, 352px)");
 expect(scroll.hasAttribute("data-canvas-no-zoom")).toBe(true);
 expect(scroll.querySelectorAll("section")).toHaveLength(12);
 expect(details.querySelector("summary")?.textContent).toContain("12 项");
 expect(scroll.previousElementSibling?.tagName).toBe("SUMMARY");
 expect(scroll.nextElementSibling?.textContent).toContain("合入所选资产");
 expect(scroll.nextElementSibling?.textContent).toContain("丢弃候选");
 expect(scroll.querySelectorAll("button")).toHaveLength(0);
 const lastSelect=scroll.querySelector<HTMLSelectElement>('[aria-label="候选 12处理方式"]')!;
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(lastSelect,"new");
  lastSelect.dispatchEvent(new Event("change",{bubbles:true}));
 });
 const commit=[...details.querySelectorAll("button")].find(button=>button.textContent==="合入所选资产")!;
 await act(async()=>commit.click());
 expect(apply).toHaveBeenCalledWith({"candidate-12":{action:"new",targetId:undefined}});
});
it("uses the canvas theme for the review, both selects, scrollbars and primary/secondary actions and responds to theme changes",async()=>{
 const {div,apply}=await mount(false,undefined,[{...candidates[0],id:"existing"}]);
 const review=div.querySelector<HTMLElement>("[data-asset-candidate-review]")!;
 const select=review.querySelector<HTMLSelectElement>('[aria-label="候选 1处理方式"]')!;
 const row=review.querySelector<HTMLElement>("section")!;
 const scroll=review.querySelector<HTMLElement>("[data-asset-candidate-scroll-region]")!;
 const merge=[...review.querySelectorAll("button")].find(b=>b.textContent==="合入所选资产")!;
 const discard=[...review.querySelectorAll("button")].find(b=>b.textContent==="丢弃候选")!;
 const css=(name:string,value:string)=>{const sample=document.createElement("div");sample.style.setProperty(name,value);return sample.style.getPropertyValue(name);};
 const check=(appearance:"light"|"dark")=>{
  const theme=canvasThemes[appearance];
  expect(review.style.background).toBe(css("background",theme.node.panel));
  expect(review.style.color).toBe(css("color",theme.node.text));
  expect(review.style.borderColor).toBe(css("border-color",theme.node.stroke));
  expect(row.style.background).toBe(css("background",theme.node.code.surface));
  expect(row.style.borderColor).toBe(css("border-color",theme.node.stroke));
  expect(scroll.style.scrollbarColor).toBe(css("scrollbar-color",theme.node.code.scrollbar+" transparent"));
  for(const field of [select,review.querySelector<HTMLSelectElement>('[aria-label="候选 1匹配目标"]')!]){
   expect(field.style.background).toBe(css("background",theme.node.panel));
   expect(field.style.color).toBe(css("color",theme.node.text));
   expect(field.style.borderColor).toBe(css("border-color",theme.node.stroke));
   expect(field.style.colorScheme).toBe(appearance);
  }
  expect(merge.style.background).toBe(css("background",theme.node.activeStroke));
  expect(discard.style.background).toBe(css("background",theme.node.panel));
 };
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(select,"reuse");
  select.dispatchEvent(new Event("change",{bubbles:true}));
 });
 check("light");
 await act(async()=>useThemeStore.setState({theme:"dark"}));
 check("dark");
 expect(select.value).toBe("reuse");
 expect(review.querySelector<HTMLSelectElement>('[aria-label="候选 1匹配目标"]')?.value).toBe("existing");
 await act(async()=>merge.click());
 expect(apply).toHaveBeenCalledWith({"candidate-1":{action:"reuse",targetId:"existing"}});
});
it("submits a candidate review only once while its backend transaction is pending",async()=>{
 let complete:()=>void=()=>{};
 const pending=new Promise<void>(resolve=>{complete=resolve;});
 const {div,apply,discard}=await mount(false,()=>pending);
 const button=[...div.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="合入所选资产")!;
 await act(async()=>{
  button.click();button.click();
  await Promise.resolve();
 });
 expect(apply).toHaveBeenCalledTimes(1);
 expect(button.disabled).toBe(true);
 expect(div.querySelector<HTMLSelectElement>('[aria-label="候选 1处理方式"]')?.disabled).toBe(true);
 const discardButton=[...div.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="丢弃候选")!;
 expect(discardButton.disabled).toBe(true);
 await act(async()=>{complete();await pending;});
 expect(button.disabled).toBe(false);
 expect(discardButton.disabled).toBe(false);
 expect(discard).not.toHaveBeenCalled();
});

it("filters expanded reviews, applies bulk decisions only to visible entries, and retains them on rejection",async()=>{
 const {useState}=await import("react");
 const {AssetReviewContext,emptyAssetReview}=await import("./drama-asset-directory-state");
 const all:DramaAsset[]=[...candidates,{id:"scene",kind:"scene",name:"森林",description:"夜景",sourceRefs:[]}];
 const div=document.createElement("div");document.body.append(div);const root=createRoot(div);roots.push(root);
 const apply=vi.fn(async()=>{throw Error("drama_asset_candidate_conflict")});
 function Host(){
  const [show,setShow]=useState(true),[candidateId,setId]=useState("batch1");
  const review=useState(()=>emptyAssetReview(""));
  return <AssetReviewContext.Provider value={review}>
   <button onClick={()=>setShow(v=>!v)}>切换</button><button onClick={()=>setId("batch2")}>新批次</button>
   {show&&<DramaAssetCandidates expanded candidateId={candidateId} assets={[]} candidates={all} disabled={false} onApply={apply} onDiscard={()=>{}}/>}
  </AssetReviewContext.Provider>;
 }
 await act(async()=>root.render(<Host/>));
 const click=async(label:string)=>{const b=[...div.querySelectorAll<HTMLButtonElement>("button")].find(x=>x.textContent===label)!;expect(b).toBeTruthy();await act(async()=>b.click());};
 const change=async(label:string,value:string)=>{const el=div.querySelector<HTMLSelectElement>('select[aria-label="'+label+'"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(el,value);el.dispatchEvent(new Event("change",{bubbles:true}));});};
 const toolbar=()=>div.querySelector("[data-asset-review-toolbar]")!;
 expect(toolbar().textContent).toContain("待审核 13");
 expect([...div.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="合入所选资产")?.disabled).toBe(true);
 await change("候选资产类别","scene");
 expect(div.querySelectorAll('[data-asset-candidate-scroll-region] section')).toHaveLength(1);
 await click("筛选项全部新增");
 expect(toolbar().textContent).toContain("待合入 1");
 await change("候选资产类别","character");await change("候选审核状态","pending");
 await click("筛选项全部跳过");
 expect(toolbar().textContent).toContain("明确跳过 12");
 expect(toolbar().textContent).toContain("待审核 0");
 await click("切换");await click("切换");
 expect(toolbar().textContent).toContain("待合入 1");
 expect(div.querySelector<HTMLSelectElement>('[aria-label="候选审核状态"]')?.value).toBe("pending");
 await click("合入所选资产");
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({scene:{action:"new"},"candidate-1":{action:"skip"}}));
 expect(div.querySelector('[role="alert"]')?.textContent).toContain("drama_asset_candidate_conflict");
 expect(toolbar().textContent).toContain("待合入 1");
 await click("新批次");
 expect(toolbar().textContent).toContain("待审核 13");
 expect(toolbar().textContent).toContain("待合入 0");
});
it("prevents scroll/drag gestures in candidate list from reaching the canvas and retains the discard action",async()=>{
 const {div,discard,parentWheel,parentPointer}=await mount();
 const scroll=div.querySelector<HTMLElement>('[data-asset-candidate-scroll-region]')!;
 await act(async()=>{
  scroll.dispatchEvent(new WheelEvent("wheel",{bubbles:true}));
  scroll.dispatchEvent(new Event("pointerdown",{bubbles:true}));
 });
 expect(parentWheel).not.toHaveBeenCalled();
 expect(parentPointer).not.toHaveBeenCalled();
 const discardButton=[...div.querySelectorAll("button")].find(button=>button.textContent==="丢弃候选")!;
 await act(async()=>discardButton.click());
 expect(discard).toHaveBeenCalledOnce();
});
