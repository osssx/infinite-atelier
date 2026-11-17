// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,describe,expect,it,vi} from "vitest";
import {CanvasTextVersionsButton} from "./canvas-text-versions-button";
import {canvasThemes} from "@/lib/canvas-theme";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
describe("text history node entry",()=>{
 let root:Root|undefined;let host:HTMLDivElement;
 afterEach(()=>{if(root)act(()=>root?.unmount());root=undefined;host?.remove();});
 it("opens the requested node panel and stops canvas gesture propagation",async()=>{
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const open=vi.fn(),parent=vi.fn();
  await act(async()=>root?.render(createElement("div",{onClick:parent},createElement(CanvasTextVersionsButton,{nodeId:"text-1",label:"History",theme:canvasThemes.dark,onOpen:open}))));
  const button=host.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("History");expect(button.title).toBe("History");
  await act(async()=>button.dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(open).toHaveBeenCalledWith("text-1");expect(parent).not.toHaveBeenCalled();
  for(const type of ["pointerdown","mousedown","dblclick"]){
   const event=new MouseEvent(type,{bubbles:true});const stopped=vi.spyOn(event,"stopPropagation");
   await act(async()=>button.dispatchEvent(event));expect(stopped).toHaveBeenCalled();
  }
 });
});
