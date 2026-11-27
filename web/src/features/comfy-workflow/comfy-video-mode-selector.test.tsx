// @vitest-environment happy-dom
import {describe,expect,it,vi} from "vitest";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {ComfyVideoModeSelector} from "./comfy-video-mode-selector";
import {minimaxH3Ref2VBundledTemplate} from "./minimax-h3-ref2v-preset";
import type {MediaModeId} from "@/services/media-capabilities";
const template={...minimaxH3Ref2VBundledTemplate(),id:"h3",revision:"test"};
describe("H3 video mode selector",()=>{
 it("offers all five modes and can return to automatic mode",async()=>{
  const container=document.createElement("div");
  const root=createRoot(container);
  const changed=vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const render=async(value?:MediaModeId)=>act(async()=>root.render(<ComfyVideoModeSelector template={template} value={value} activeMode="omni_reference" onChange={changed}/>));
  try{
   await render();
   const select=container.querySelector("select")!;
   expect([...select.options].map(option=>option.value)).toEqual(["","text_to_video","omni_reference","first_frame","last_frame","first_last_frame"]);
   expect(select.options[0].textContent).toContain("全能参考");
   for(const mode of ["first_frame","last_frame","first_last_frame"] as const){
    await act(async()=>{select.value=mode;select.dispatchEvent(new Event("change",{bubbles:true}));});
    expect(changed).toHaveBeenLastCalledWith(mode);
    await render(mode);
    expect(container.textContent).toContain("不会自动添加提示词");
    expect(container.textContent).not.toContain("自动加入提示词");
    expect(container.textContent).toContain("请使用自己的提示词");
   }
   await act(async()=>{select.value="";select.dispatchEvent(new Event("change",{bubbles:true}));});
   expect(changed).toHaveBeenLastCalledWith(undefined);
  }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();}
 });
});
