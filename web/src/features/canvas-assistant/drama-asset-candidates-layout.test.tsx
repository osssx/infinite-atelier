// @vitest-environment happy-dom
import {act} from "react";
import type {ReactNode} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {DramaAsset} from "./canvas-drama-pipeline";

vi.mock("antd",()=>({
 Button:({children,disabled,onClick}:{children:ReactNode;disabled?:boolean;onClick?:()=>void})=>
  <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
}));
import {DramaAssetCandidates} from "./drama-asset-candidates";

const roots:Root[]=[];
const candidates:DramaAsset[]=Array.from({length:12},(_,index)=>({
 id:"candidate-"+(index+1),kind:"character",name:"候选 "+(index+1),
 description:"一段较长的角色形象描述。".repeat(15),sourceRefs:[]
}));
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{
 for(const root of roots)await act(async()=>root.unmount());
 roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();
});
async function mount(disabled=false){
 const div=document.createElement("div");document.body.append(div);
 const root=createRoot(div);roots.push(root);
 const apply=vi.fn(),discard=vi.fn(),parentWheel=vi.fn(),parentPointer=vi.fn();
 await act(async()=>root.render(<div onWheel={parentWheel} onPointerDown={parentPointer}>
  <DramaAssetCandidates assets={[]} candidates={candidates}
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
