// @vitest-environment happy-dom
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,describe,expect,it,vi} from "vitest";
const {themeState}=vi.hoisted(()=>({themeState:{theme:"dark" as "dark"|"light"}}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string,values?:Record<string,unknown>)=>values?`${key}:${Object.values(values).join("/")}`:key})}));
vi.mock("./canvas-text-markdown",()=>({CanvasTextMarkdown:({content}:{content:string})=>createElement("div",null,content)}));
vi.mock("@/stores/use-theme-store",()=>({useThemeStore:(select:(state:{theme:"dark"|"light"})=>unknown)=>select(themeState)}));
import {CanvasTextVersionsModal} from "./canvas-text-versions-modal";
import type {TextVersion} from "@/features/canvas-text-versions";
import {canvasThemes} from "@/lib/canvas-theme";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
describe("text version modal interactions",()=>{
 let root:Root|undefined;let host:HTMLDivElement;
 afterEach(()=>{if(root)act(()=>root?.unmount());root=undefined;host?.remove();});
 it("selects a preview and invokes save, delete, and restore actions",async()=>{
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const version:TextVersion={id:"v1",createdAt:"2026-01-01T00:00:00.000Z",content:"# old text",note:"snapshot",source:"manual"};
  const save=vi.fn(async()=>{}),remove=vi.fn(),restore=vi.fn(),close=vi.fn();
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,{open:true,versions:[version],currentContent:"new text",onClose:close,onSave:save,onDelete:remove,onRestore:restore,onRetryPersistence:async()=>{},retryPending:false})));
  const preview=[...document.body.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="snapshot");expect(preview).toBeTruthy();
  await act(async()=>preview?.click());
  expect(document.body.textContent).toContain("# old text");
  const saveButton=[...document.body.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="canvas.textVersions.saveCurrent");
  await act(async()=>saveButton?.click());expect(save).toHaveBeenCalledTimes(1);
  const deleteButton=[...document.body.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="common.delete");
  await act(async()=>deleteButton?.click());
  const confirm=[...document.body.querySelectorAll("button")].find(b=>b.textContent==="OK");
  if(confirm)await act(async()=>confirm.click());
  expect(remove).toHaveBeenCalledWith("v1");
  const restoreButton=[...document.body.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="common.restore");
  await act(async()=>restoreButton?.click());expect(restore).toHaveBeenCalledWith(version);
 });
 it("selects a version added to an initially empty list and retries persistence",async()=>{
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const retry=vi.fn(async()=>{});const saved:TextVersion={id:"new",createdAt:"now",content:"new body",source:"manual"};
  const props={open:true,versions:[] as TextVersion[],currentContent:"current",onClose:vi.fn(),onSave:vi.fn(),onDelete:vi.fn(),onRestore:vi.fn(),onRetryPersistence:retry,retryPending:true};
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,props)));
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,{...props,versions:[saved]})));
  expect(document.body.textContent).toContain("new body");
  const restore=[...document.body.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="common.restore");
  expect(restore?.hasAttribute("disabled")).toBe(true);
  const retryButton=[...document.body.querySelectorAll("button")].find(b=>b.textContent==="canvas.textVersions.retry");
  await act(async()=>retryButton?.click());
  expect(retry).toHaveBeenCalledTimes(1);
 });
 it("clears a save note only after success and uses light/dark canvas surfaces",async()=>{
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const versions:TextVersion[]=[];const fail=vi.fn(async()=>{throw Error("network");});
  const props={open:true,versions,currentContent:"body",onClose:vi.fn(),onSave:fail,onDelete:vi.fn(),onRestore:vi.fn(),onRetryPersistence:async()=>{},retryPending:false};
  themeState.theme="dark";
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,props)));
  const input=document.body.querySelector<HTMLInputElement>("input[aria-label='canvas.textVersions.notePlaceholder']")!;
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
  await act(async()=>{setter?.call(input,"keep this note");input.dispatchEvent(new Event("input",{bubbles:true}));});
  const save=[...document.body.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="canvas.textVersions.saveCurrent")!;
  await act(async()=>save.click());
  expect(input.value).toBe("keep this note");
  expect(fail).toHaveBeenCalledWith("keep this note");

  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,{...props,onSave:async()=>{}})));
  await act(async()=>save.click());
  expect(input.value).toBe("");

  const shell=document.body.querySelector<HTMLElement>(".ant-modal-container")!;
  expect(shell.style.background).toBe(canvasThemes.dark.node.panel);
  themeState.theme="light";
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,{...props,onSave:async()=>{}})));
  const lightShell=document.body.querySelector<HTMLElement>(".ant-modal-container")!;
  expect(lightShell.style.background).toBe(canvasThemes.light.node.panel);
 });
 it("closes on Escape from modal focus, preserves nested overlays, and consumes Escape while busy",async()=>{
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const close=vi.fn();const props={open:true,versions:[] as TextVersion[],currentContent:"text",onClose:close,onSave:vi.fn(),onDelete:vi.fn(),onRestore:vi.fn(),onRetryPersistence:async()=>{},retryPending:false};
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,props)));
  const input=document.body.querySelector("input")!;
  await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",keyCode:27,which:27,bubbles:true,cancelable:true})));
  expect(close).toHaveBeenCalledTimes(1);

  close.mockClear();
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,props)));
  const version:TextVersion={id:"v",createdAt:"now",content:"saved",source:"manual"};
  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,{...props,versions:[version]})));
  const deleteButton=[...document.body.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="common.delete")!;
  await act(async()=>deleteButton.click());
  expect(document.body.textContent).toContain("canvas.textVersions.deleteConfirm");
  await act(async()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",keyCode:27,which:27,bubbles:true,cancelable:true})));
  expect(close).not.toHaveBeenCalled();
  const cancelPopover=[...(document.body.querySelector(".ant-popover")?.querySelectorAll("button")??[])].find(button=>button.textContent==="Cancel");
  if(cancelPopover)await act(async()=>cancelPopover.click());
  await act(async()=>new Promise(resolve=>setTimeout(resolve,250)));
  await act(async()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",keyCode:27,which:27,bubbles:true,cancelable:true})));
  expect(close).toHaveBeenCalledTimes(1);
  close.mockClear();

  await act(async()=>root?.render(createElement(CanvasTextVersionsModal,{...props,busy:true})));
  await act(async()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",keyCode:27,which:27,bubbles:true,cancelable:true})));
  expect(close).not.toHaveBeenCalled();
 });
});
