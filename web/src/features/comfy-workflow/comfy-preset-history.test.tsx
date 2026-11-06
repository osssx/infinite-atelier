import {isValidElement,type ReactElement} from "react";
import {beforeEach,describe,expect,it,vi} from "vitest";

const h=vi.hoisted(()=>({cursor:0,slots:[] as any[],effects:[] as (()=>void)[],confirm:vi.fn(),message:{success:vi.fn(),warning:vi.fn(),error:vi.fn()},list:vi.fn(),presets:vi.fn(),restore:vi.fn(),note:vi.fn(),remove:vi.fn(),refs:vi.fn(),snapshot:vi.fn()}));
vi.mock("react",async original=>{
 const actual=await original<typeof import("react")>();
 const slot=()=>{const i=h.cursor++;return h.slots[i]??(h.slots[i]={});};
 const changed=(old:unknown[]|undefined,next:unknown[])=>!old||old.length!==next.length||next.some((v,i)=>!Object.is(v,old[i]));
 return {...actual,
  useState:(initial:unknown)=>{const s=slot();if(!("value" in s))s.value=typeof initial==="function"?initial():initial;return [s.value,(v:any)=>{s.value=typeof v==="function"?v(s.value):v;}];},
  useRef:(initial:unknown)=>{const s=slot();return s.value??(s.value={current:initial});},
  useMemo:(fn:()=>unknown,deps:unknown[])=>{const s=slot();if(changed(s.deps,deps)){s.value=fn();s.deps=deps;}return s.value;},
  useCallback:(fn:unknown,deps:unknown[])=>{const s=slot();if(changed(s.deps,deps)){s.value=fn;s.deps=deps;}return s.value;},
  useEffect:(fn:()=>unknown,deps:unknown[])=>{const s=slot();if(changed(s.deps,deps)){s.deps=deps;h.effects.push(()=>{s.cleanup?.();s.cleanup=fn();});}},
 };
});
vi.mock("antd",()=>({App:{useApp:()=>({message:h.message,modal:{confirm:h.confirm}})},Button:"button",Modal:"dialog",Input:"input",Checkbox:"checkbox",Spin:"spinner",Tag:"mark"}));
vi.mock("./preset-registry",()=>({listComfyWorkflowVersions:h.list,listComfyPresets:h.presets,restoreComfyPresetVersion:h.restore,setComfyVersionNote:h.note,deleteComfyVersions:h.remove,getComfyVersionReferences:h.refs}));
vi.mock("./template-registry",()=>({getComfyTemplate:h.snapshot}));
import {ComfyPresetHistory} from "./comfy-preset-history";
const preset={id:"preset",name:"Preset",workflowId:"family",templateId:"base",revision:"current"};
const version=(i:number,templateId="base")=>({templateId,revision:`rev-${i}`,shortRevision:`rev-${i}`,createdAt:i,note:i===2?"Known good":"",references:{count:i===1?2:0}});
const props={preset,onClose:vi.fn(),onChanged:vi.fn()};
function elements(tree:unknown):ReactElement<Record<string,any>>[]{
 if(Array.isArray(tree))return tree.flatMap(elements);
 if(!isValidElement(tree))return [];
 const e=tree as ReactElement<Record<string,any>>;
 if(e.props.open===false)return [];
 return [e,...elements(e.props.children)];
}
function text(tree:unknown):string{
 if(Array.isArray(tree))return tree.map(text).join("");
 if(isValidElement(tree))return text((tree.props as any).children);
 return typeof tree==="string"||typeof tree==="number"?String(tree):"";
}
const render=()=>{h.cursor=0;const tree=ComfyPresetHistory(props);h.effects.splice(0).forEach(fn=>fn());return elements(tree);};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const button=(name:string,tree=render())=>{const result=tree.find(e=>e.type==="button"&&(text(e.props.children)===name||e.props["aria-label"]===name));expect(result,`button ${name}`).toBeDefined();return result!;};
const click=async(name:string)=>{button(name).props.onClick();await flush();};
const mount=async()=>{render();await flush();return render();};
const content=()=>render().map(e=>text(e.props.children)).join(" ");
beforeEach(()=>{
 h.slots.forEach(s=>s.cleanup?.());h.cursor=0;h.slots=[];h.effects=[];vi.clearAllMocks();
 h.list.mockResolvedValue([version(1),version(2),version(99,"variant")]);h.presets.mockResolvedValue([preset]);h.restore.mockResolvedValue({});h.note.mockResolvedValue({});h.remove.mockResolvedValue({deleted:1});
});
describe("simplified preset history",()=>{
 it("shows only this template, twenty newest rows and reveals more on demand",async()=>{
  h.list.mockResolvedValue([...Array.from({length:25},(_,i)=>version(i)),version(99,"variant")]);
  const tree=await mount();expect(tree.filter(e=>e.type==="button"&&e.props["aria-label"]==="编辑备注")).toHaveLength(20);
  expect(content()).not.toContain("rev-99");expect(content()).toContain("未填写备注");
  expect(tree.some(e=>e.type==="checkbox"||e.type==="code")).toBe(false);
  expect(tree.some(e=>e.type==="button"&&text(e.props.children)==="引用详情")).toBe(false);
  expect(tree.find(e=>e.type==="dialog")?.props.width).toBe(640);
  await click("显示更多（5）");expect(render().filter(e=>e.type==="button"&&e.props["aria-label"]==="编辑备注")).toHaveLength(25);
 });
 it("hides restore for the current identity and starts advanced controls collapsed",async()=>{
  h.list.mockResolvedValue([{...version(1),revision:preset.revision}]);await mount();
  expect(content()).toContain("当前使用");expect(render().some(e=>e.type==="button"&&text(e.props.children)==="恢复此版本")).toBe(false);
  expect(button("高级管理").props["aria-expanded"]).toBe(false);
 });
 it("requires explicit note save, cancellation writes nothing and save failure retains draft",async()=>{
  await mount();await click("编辑备注");
  const input=render().find(e=>e.type==="input")!;expect(input.props.maxLength).toBe(200);expect(input.props.onBlur).toBeUndefined();
  input.props.onChange({target:{value:"draft"}});await click("取消");expect(h.note).not.toHaveBeenCalled();
  await click("编辑备注");render().find(e=>e.type==="input")!.props.onChange({target:{value:"retry draft"}});
  h.note.mockRejectedValueOnce(Error("offline"));await click("保存");expect(render().find(e=>e.type==="input")?.props.value).toBe("retry draft");
  await click("保存");expect(h.note).toHaveBeenLastCalledWith("base","rev-2","retry draft");expect(render().some(e=>e.type==="input")).toBe(false);
 });
 it("clears selections on collapse and preserves deletion reference guards",async()=>{
  await mount();await click("高级管理");const checks=render().filter(e=>e.type==="checkbox");
  expect(checks.map(e=>e.props.disabled)).toEqual([false,true]);checks[0].props.onChange({target:{checked:true}});
  expect(button("删除所选（1）").props.disabled).toBe(false);await click("高级管理");await click("高级管理");
  expect(button("删除所选（0）").props.disabled).toBe(true);expect(render().filter(e=>e.type==="button"&&text(e.props.children)==="删除").map(e=>e.props.disabled)).toEqual([false,true]);
 });
 it("bulk deletion requires confirmation and passes identities, not the modal close argument",async()=>{
  await mount();await click("高级管理");render().find(e=>e.type==="checkbox"&&!e.props.disabled)!.props.onChange({target:{checked:true}});await click("删除所选（1）");
  expect(h.remove).not.toHaveBeenCalled();await h.confirm.mock.calls.at(-1)![0].onOk(vi.fn());await flush();
  expect(h.remove).toHaveBeenCalledWith([{templateId:"base",revision:"rev-2"}]);
 });
 it("single deletion confirms the selected version and refreshes reference guards after conflict",async()=>{
  await mount();await click("高级管理");await click("删除");
  const confirm=h.confirm.mock.calls.at(-1)![0];expect(h.remove).not.toHaveBeenCalled();
  h.remove.mockRejectedValueOnce({status:409});h.list.mockResolvedValue([{...version(2),references:{count:1}},version(1)]);
  await confirm.onOk(vi.fn());await flush();
  expect(h.remove).toHaveBeenCalledWith([{templateId:"base",revision:"rev-2"}]);
  expect(render().filter(e=>e.type==="button"&&text(e.props.children)==="删除").every(e=>e.props.disabled)).toBe(true);
 });
 it("successful restore confirms date/note, stays open and marks restored version current",async()=>{
  await mount();await click("恢复此版本");const confirm=h.confirm.mock.calls.at(-1)![0];
  expect(text(confirm.content)).toContain("Known good");expect(text(confirm.content)).toContain(new Date(2).toLocaleString());
  h.presets.mockResolvedValue([{...preset,revision:"rev-2"}]);await confirm.onOk();await flush();
  expect(props.onClose).not.toHaveBeenCalled();expect(props.onChanged).toHaveBeenCalled();expect(content()).toContain("当前使用");
  expect(render().filter(e=>e.type==="button"&&text(e.props.children)==="恢复此版本")).toHaveLength(1);
 });
 it("refreshes CAS state after conflict so a new confirmation can retry",async()=>{
  await mount();await click("恢复此版本");h.restore.mockRejectedValueOnce({status:409});h.presets.mockResolvedValue([{...preset,revision:"updated"}]);
  await h.confirm.mock.calls.at(-1)![0].onOk();await flush();render();await click("恢复此版本");await h.confirm.mock.calls.at(-1)![0].onOk();
  expect(h.restore.mock.calls[1][2].revision).toBe("updated");
 });
 it("offers retry after a list failure",async()=>{
  h.list.mockRejectedValueOnce(Error("offline"));await mount();expect(content()).toContain("offline");await click("重试");expect(content()).not.toContain("offline");
 });
 it("disables restore if conflict refresh fails and retry recovers the latest preset",async()=>{
  await mount();await click("恢复此版本");h.restore.mockRejectedValueOnce({status:409});h.presets.mockRejectedValueOnce(Error("offline"));
  await h.confirm.mock.calls.at(-1)![0].onOk();await flush();
  expect(button("恢复此版本").props.disabled).toBe(true);
  h.presets.mockResolvedValue([{...preset,revision:"updated"}]);await click("重试");
  expect(button("恢复此版本").props.disabled).toBe(false);
 });
});
