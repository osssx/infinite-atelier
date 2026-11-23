// @vitest-environment happy-dom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("antd",()=>({Button:({children,icon,onClick,disabled,style}:{
 children:React.ReactNode;icon:React.ReactNode;onClick?:()=>void;disabled?:boolean;style?:React.CSSProperties
})=><button type="button" onClick={onClick} disabled={disabled} style={style}>{icon}{children}</button>}));
import {DramaSourceNode} from "./drama-source-node";
const roots:Root[]=[];
beforeEach(()=>vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true));
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;document.body.replaceChildren();vi.unstubAllGlobals();});
async function mount(hideTextEditor=false){
 const element=document.createElement("div");document.body.append(element);
 const root=createRoot(element);roots.push(root);
 const onOpen=vi.fn(),onChange=vi.fn();
 const node={id:"source-1",type:"drama:source",title:"故事",position:{x:0,y:0},width:340,height:350,
  metadata:{dramaDraft:"这是一段相当长的故事。".repeat(200),videoRatio:"16:9"}} as CanvasNodeData;
 await act(async()=>root.render(<DramaSourceNode node={node} onChange={onChange}
  onOpenEditor={hideTextEditor?undefined:onOpen} hideTextEditor={hideTextEditor}
  onOpenVersions={()=>{}} onConfirmVersion={async()=>{}} versionBusy={false}/>));
 return {element,onOpen,onChange};
}
it("renders a compact, bounded story preview that opens the full editor",async()=>{
 const {element,onOpen}=await mount();
 const preview=element.querySelector<HTMLButtonElement>('[data-story-inline-summary]')!;
 expect(preview).toBeTruthy();
 expect(preview.textContent).toContain("完整编辑器");
 expect(preview.textContent!.length).toBeLessThan(470);
 expect(element.querySelector('textarea[placeholder="粘贴原文"]')).toBeNull();
 await act(async()=>preview.click());
 expect(onOpen).toHaveBeenCalledTimes(1);
});
it("keeps visual settings available without duplicating the story textarea",async()=>{
 const {element,onChange}=await mount(true);
 expect(element.querySelector('[data-story-inline-summary]')).toBeNull();
 expect(element.querySelector('textarea[placeholder="粘贴原文"]')).toBeNull();
 const ratio=element.querySelector<HTMLSelectElement>("select")!;
 expect(ratio.value).toBe("16:9");
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(ratio,"9:16");
  ratio.dispatchEvent(new Event("change",{bubbles:true}));
 });
 expect(onChange).toHaveBeenCalledWith({videoRatio:"9:16"});
});
