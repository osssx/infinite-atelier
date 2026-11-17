// @vitest-environment happy-dom
import {act,createElement,useEffect,useRef,type MutableRefObject} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,describe,expect,it,vi} from "vitest";
import {CanvasActionsProvider,useCanvasActions,type CanvasActions} from "./canvas-actions";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const makeActions=(open:(id:string)=>void):CanvasActions=>({
 onMouseDown:()=>{},onSelectCapture:()=>{},onHoverStart:()=>{},onHoverEnd:()=>{},onConnectStart:()=>{},onResizeStart:()=>{},onResize:()=>{},onResizeEnd:()=>{},onImageDimensions:()=>{},onVideoDimensions:()=>{},onContentChange:()=>{},onTitleChange:()=>{},onTitleEditingChange:()=>{},onContextMenu:()=>{},onToggleBatch:()=>{},onSetBatchPrimary:()=>{},onDuplicateBatchImage:()=>{},onRetryBatchImage:()=>{},onDeleteBatchImage:()=>{},onRetry:()=>{},onGenerateImage:()=>{},onOpenTextVersions:open,onViewImage:()=>{},
});
function Probe({capture}:{capture:MutableRefObject<CanvasActions|null>}){const actions=useCanvasActions();useEffect(()=>{capture.current=actions;});return createElement("button",{onClick:()=>actions.onOpenTextVersions("text-1")});}
describe("canvas text history action handoff",()=>{
 let root:Root|undefined;let host:HTMLDivElement;
 afterEach(()=>{if(root)act(()=>root?.unmount());root=undefined;host?.remove();});
 it("keeps a stable facade while forwarding the latest open-panel callback",async()=>{
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const facade={current:null as CanvasActions|null};const first=vi.fn(),latest=vi.fn();const child=createElement(Probe,{capture:facade});
  await act(async()=>root?.render(createElement(CanvasActionsProvider,{actions:makeActions(first),children:child})));
  const stable=facade.current;
  await act(async()=>root?.render(createElement(CanvasActionsProvider,{actions:makeActions(latest),children:child})));
  expect(facade.current).toBe(stable);
  await act(async()=>host.querySelector("button")?.click());
  expect(first).not.toHaveBeenCalled();expect(latest).toHaveBeenCalledWith("text-1");
 });
});
