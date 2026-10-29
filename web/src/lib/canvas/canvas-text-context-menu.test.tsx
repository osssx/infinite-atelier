import {readFileSync} from "node:fs";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {isNativeTextEditorTarget} from "./canvas-text-context-menu";

class FakeElement {
 constructor(readonly kind:string,readonly parent:FakeElement|null=null,readonly editable=false){}
 closest(selector:string):FakeElement|null{
  for(let el:FakeElement|null=this;el;el=el.parent){
   if(selector.includes("input,textarea,select")&&["input","textarea","select"].includes(el.kind))return el;
   if(selector.includes("[contenteditable]")&&el.editable)return el;
  }
  return null;
 }
}
vi.mock("@/stores/use-theme-store",()=>({
 useThemeStore:(select:(state:{theme:"light"})=>unknown)=>select({theme:"light"}),
}));
vi.mock("react-i18next",()=>({
 useTranslation:()=>({t:(key:string)=>({
  "canvas.controls.duplicate":"复制节点","canvas.controls.delete":"删除节点",
  "canvas.controls.disconnect":"断开连接",
 } as Record<string,string>)[key]??key}),
}));
import {CanvasNodeContextMenu} from "@/components/canvas/canvas-context-menu";
import type {ContextMenuState} from "@/types/canvas";

beforeEach(()=>vi.stubGlobal("Element",FakeElement));
afterEach(()=>vi.unstubAllGlobals());

describe("canvas text right click native paste",()=>{
 it("recognizes inputs, textareas, selects, rich editors and nested children",()=>{
  for(const type of ["input","textarea","select"]){
   const field=new FakeElement(type);
   expect(isNativeTextEditorTarget(field as unknown as EventTarget)).toBe(true);
   expect(isNativeTextEditorTarget(new FakeElement("span",field) as unknown as EventTarget)).toBe(true);
  }
  const rich=new FakeElement("div",null,true);
  expect(isNativeTextEditorTarget(rich as unknown as EventTarget)).toBe(true);
  expect(isNativeTextEditorTarget(new FakeElement("em",rich) as unknown as EventTarget)).toBe(true);
  expect(isNativeTextEditorTarget(new FakeElement("div") as unknown as EventTarget)).toBe(false);
  expect(isNativeTextEditorTarget(null)).toBe(false);
 });
 it("never preventDefault on native editor menus at canvas root or inside a node",()=>{
  const page=readFileSync(new URL("../../pages/canvas/project.tsx",import.meta.url),"utf8");
  const root=page.slice(page.indexOf("const preventCanvasContextMenu = useCallback"),
   page.indexOf("const handleGenerateNode = useCallback"));
  const start=page.indexOf("const handleNodeContextMenu = useCallback");
  const node=page.slice(start,page.indexOf("const monitorSqliteJob=",start));
  for(const source of [root,node]){
   const index=source.indexOf("if (isNativeTextEditorTarget(event.target))");
   expect(index).toBeGreaterThan(-1);
   const branch=source.slice(index,source.indexOf("return;",index)+7);
   expect(branch).not.toContain("event.preventDefault()");
   expect(branch).toContain("setContextMenu(null)");
  }
  expect(node).toContain("event.stopPropagation()");
  expect(node).toContain('setContextMenu({ type: "node"');
  expect(root).toContain("event.preventDefault()");
  expect(page).not.toContain("captureCanvasTextEditContext");
  expect(page).not.toContain("insertCanvasClipboardText");
  expect(page).not.toContain("onPasteText=");
 });
 it("retains node/connection menu without custom clipboard actions",()=>{
  const render=(menu:ContextMenuState)=>renderToStaticMarkup(createElement(CanvasNodeContextMenu,{
   menu,onClose:()=>{},onDuplicate:()=>{},onDelete:()=>{}
  }));
  const node=render({type:"node",x:8,y:10,nodeId:"n"});
  expect(node).toContain("复制节点");expect(node).toContain("删除节点");
  expect(node).not.toContain("粘贴文本");
  const edge=render({type:"connection",x:8,y:10,connectionId:"e"});
  expect(edge).toContain("断开连接");
  const component=readFileSync(new URL("../../components/canvas/canvas-context-menu.tsx",import.meta.url),"utf8");
  expect(component).not.toContain("onPasteText");
  expect(component).not.toContain("navigator.clipboard");
 });
});
