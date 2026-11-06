import {isValidElement,type ReactElement} from "react";
import {beforeEach,describe,expect,it,vi} from "vitest";

const state=vi.hoisted(()=>({cursor:0,slots:new Map<number,unknown>(),message:{success:vi.fn(),error:vi.fn(),info:vi.fn()}}));
const preset={id:"preset",name:"Preset",workflowId:"workflow",templateId:"workflow",revision:"b".repeat(64)};
vi.mock("react",async importOriginal=>{
 const actual=await importOriginal<typeof import("react")>();
 return {...actual,useEffect:()=>{},useMemo:(fn:()=>unknown)=>fn(),useCallback:(fn:unknown)=>fn,useRef:(value:unknown)=>({current:value}),
  useState:(initial:unknown)=>{
   const index=state.cursor++;
   if(!state.slots.has(index))state.slots.set(index,initial);
   return [state.slots.get(index),(value:unknown)=>state.slots.set(index,typeof value==="function"?(value as (old:unknown)=>unknown)(state.slots.get(index)):value)];
  }};
});
vi.mock("antd",()=>({App:{useApp:()=>({message:state.message})},
 Button:"button",Input:"input",Modal:"dialog",Popconfirm:"div",Select:"select",Switch:"input",Tag:"span",Tooltip:"div",Typography:{Text:"span"}}));
vi.mock("@/stores/use-config-store",()=>({useConfigStore:(pick:(s:unknown)=>unknown)=>pick({config:{comfyAutoDetect:false},updateConfig:vi.fn()})}));
vi.mock("./comfy-workflow-panel",()=>({ComfyWorkflowPanel:()=>null}));
vi.mock("./sqlite-instances-client",()=>({listSqliteComfyInstances:vi.fn(),saveSqliteComfyInstance:vi.fn(),deleteSqliteComfyInstance:vi.fn()}));
vi.mock("./preset-catalog",()=>({listComfyPresetCatalog:async()=>[preset]}));
vi.mock("./preset-registry",()=>({deleteComfyPreset:vi.fn(),saveComfyPresetBinding:vi.fn()}));
vi.mock("./comfy-preset-history",()=>({ComfyPresetHistory:()=>null}));
import {ComfyPresetHistory} from "./comfy-preset-history";
import {ComfySettingsTab} from "./comfy-settings-tab";

function elements(tree:unknown):ReactElement<Record<string,any>>[]{
 if(Array.isArray(tree))return tree.flatMap(elements);
 if(!isValidElement(tree))return [];
 const item=tree as ReactElement<Record<string,any>>;
 return [item,...elements(item.props.children)];
}
describe("preset modification history entry",()=>{
 beforeEach(()=>{state.cursor=0;state.slots.clear();state.slots.set(5,[preset]);vi.clearAllMocks();});
 const render=()=>{state.cursor=0;return elements(ComfySettingsTab());};
 it("opens the dedicated history component and closes it without changing a preset",()=>{
  const button=render().find(e=>e.type==="button"&&e.props["aria-label"]==="修改历史 Preset");
  expect(button).toBeDefined();button!.props.onClick();
  const history=render().find(e=>e.type===ComfyPresetHistory);
  expect(history?.props.preset).toEqual(preset);
  history!.props.onClose();
  expect(render().some(e=>e.type===ComfyPresetHistory)).toBe(false);
 });
});
