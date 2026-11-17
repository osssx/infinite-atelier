// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("./canvas-text-markdown",()=>({CanvasTextMarkdown:({content}:{content:string})=>createElement("div",null,content)}));
vi.mock("@/stores/use-theme-store",()=>({useThemeStore:(select:(state:{theme:"dark"})=>unknown)=>select({theme:"dark"})}));
import {CanvasTextVersionsModal} from "./canvas-text-versions-modal";
import type {TextVersion} from "@/features/canvas-text-versions";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
describe("text version modal interactions",()=>{
 let root:Root|undefined;let host:HTMLDivElement;
 afterEach(()=>{if(root)act(()=>root?.unmount());root=undefined;host?.remove();});
 it("selects a preview and invokes save, delete, and restore actions",async()=>{
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const version:TextVersion={id:"v1",createdAt:"2026-01-01T00:00:00.000Z",content:"# old text",note:"snapshot",source:"manual"};
  const save=vi.fn(),remove=vi.fn(),restore=vi.fn(),close=vi.fn();
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,{open:true,versions:[version],currentContent:"new text",onClose:close,onSave:save,onDelete:remove,onRestore:restore,onRetryPersistence:async()=>{},retryPending:false})));
  const buttons=[...document.body.querySelectorAll("button")];
  const preview=buttons.find(b=>b.textContent?.includes("snapshot"));expect(preview).toBeTruthy();
  await act(async()=>preview?.click());
  expect(document.body.textContent).toContain("# old text");
  const saveButton=buttons.find(b=>b.textContent==="canvas.textVersions.saveCurrent");
  await act(async()=>saveButton?.click());expect(save).toHaveBeenCalledTimes(1);
  const deleteButton=[...document.body.querySelectorAll("button")].find(b=>b.textContent==="common.delete");
  await act(async()=>deleteButton?.click());
  const confirm=[...document.body.querySelectorAll("button")].find(b=>b.textContent==="OK");
  if(confirm)await act(async()=>confirm.click());
  expect(remove).toHaveBeenCalledWith("v1");
  const restoreButton=[...document.body.querySelectorAll("button")].find(b=>b.textContent==="common.restore");
  await act(async()=>restoreButton?.click());expect(restore).toHaveBeenCalledWith(version);
 });
 it("selects a version added to an initially empty list and retries persistence",async()=>{
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const retry=vi.fn(async()=>{});const saved:TextVersion={id:"new",createdAt:"now",content:"new body",source:"manual"};
  const props={open:true,versions:[] as TextVersion[],currentContent:"current",onClose:vi.fn(),onSave:vi.fn(),onDelete:vi.fn(),onRestore:vi.fn(),onRetryPersistence:retry,retryPending:true};
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,props)));
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,{...props,versions:[saved]})));
  expect(document.body.textContent).toContain("new body");
  const restore=[...document.body.querySelectorAll("button")].find(b=>b.textContent==="common.restore");
  expect(restore?.hasAttribute("disabled")).toBe(true);
  const retryButton=[...document.body.querySelectorAll("button")].find(b=>b.textContent==="canvas.textVersions.retry");
  await act(async()=>retryButton?.click());
  expect(retry).toHaveBeenCalledTimes(1);
 });
});
