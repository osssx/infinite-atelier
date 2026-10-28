import {createElement, type ComponentProps} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";

const ui=vi.hoisted(()=>({items:[] as Array<{key?:string;onClick?:()=>void}>}));
vi.mock("antd",()=>({
 Dropdown:({menu,children}:any)=>{ui.items=menu.items;return children},
 Tooltip:({children}:any)=>children,
 Modal:()=>null
}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("@/components/layout/user-status-actions",()=>({UserStatusActions:()=>null}));
vi.mock("@/stores/use-theme-store",()=>({
 useThemeStore:(select:(state:{theme:"dark"})=>unknown)=>select({theme:"dark"})
}));
vi.mock("@/stores/use-canvas-side-panel-store",()=>({
 useCanvasSidePanelStore:(select:(state:{panelOpen:boolean;togglePanel:()=>void})=>unknown)=>
  select({panelOpen:false,togglePanel:()=>{}})
}));

import {CanvasTopBar} from "./canvas-top-bar";

describe("Canvas top-left export menu",()=>{
 it("invokes the supplied current-project archive callback when Export Current Canvas is selected",()=>{
  const exportProject=vi.fn();
  const noop=()=>{};
  const props:ComponentProps<typeof CanvasTopBar>={
   title:"Current canvas",titleDraft:"Current canvas",isTitleEditing:false,
   onTitleDraftChange:noop,onStartTitleEditing:noop,onFinishTitleEditing:noop,
   onCancelTitleEditing:noop,canUndo:false,canRedo:false,
   onHome:noop,onProjects:noop,onCreateProject:noop,onDeleteProject:noop,
   onExportProject:exportProject,onImportImage:noop,onUndo:noop,onRedo:noop,
   onOpenJobHistory:noop
  };
  renderToStaticMarkup(createElement(CanvasTopBar,props));
  const entry=ui.items.find(item=>item.key==="export");
  expect(entry).toBeDefined();
  expect(entry?.onClick).toBe(exportProject);
  entry?.onClick?.();
  expect(exportProject).toHaveBeenCalledOnce();
 });
});
