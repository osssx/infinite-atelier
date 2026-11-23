// @vitest-environment happy-dom
import {act,useState,type Dispatch,type SetStateAction} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
import {useThemeStore} from "@/stores/use-theme-store";
import {canvasThemes} from "@/lib/canvas-theme";
import {DramaStoryboardFields} from "./drama-storyboard-fields";
import type {DramaAsset,DramaShot} from "./canvas-drama-pipeline";

const original:DramaShot[]=[
 {id:"shot-1",episodeId:"ep-1",order:1,description:"兔子走进森林",durationSec:5,shotSize:"全景",
  camera:"俯视",action:"向前走",dialogue:"早上好",sourceRefs:["p1"],sequenceId:"seq-1",
  sceneId:"scene-1",sceneVariantId:"variant-1",characterVariantIds:["rabbit"],propIds:["flower"],keyPropIds:["flower"]},
 {id:"shot-2",episodeId:"ep-1",order:2,description:"乌龟回应",durationSec:6,
  characterVariantIds:["turtle"],propIds:[],keyPropIds:[]},
 {id:"shot-3",episodeId:"ep-2",order:1,description:"转场",characterVariantIds:[],propIds:[],keyPropIds:[]}
];
const episodes=[
 {id:"ep-1",title:"相遇",targetDurationSec:30,sequences:[{id:"seq-1",title:"森林入口"},{id:"seq-2",title:"河边"}]},
 {id:"ep-2",title:"远行",sequences:[]},
];
const scenes:DramaAsset[]=[
 {id:"scene-1",kind:"scene",name:"森林",description:"",sourceRefs:[],
  variants:[{id:"variant-1",name:"早晨森林",description:""}]},
 {id:"scene-2",kind:"scene",name:"河畔",description:"",sourceRefs:[],
  variants:[{id:"variant-2",name:"月夜河畔",description:""}]},
];
const characters:DramaAsset[]=[
 {id:"rabbit",kind:"character",name:"小兔",description:"",sourceRefs:[],
  variants:[{id:"rabbit-red",name:"红衣",description:""},{id:"rabbit-blue",name:"蓝衣",description:""}]},
 {id:"turtle",kind:"character",name:"小龟",description:"",sourceRefs:[]},
];
const props:DramaAsset[]=[
 {id:"flower",kind:"prop",name:"花束",description:"",sourceRefs:[]},
 {id:"basket",kind:"prop",name:"篮子",description:"",sourceRefs:[]},
];

const roots:Root[]=[];
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);useThemeStore.setState({theme:"dark"});});
afterEach(async()=>{for(const x of roots)await act(async()=>x.unmount());roots.length=0;vi.unstubAllGlobals();});
async function mount(opts:{expanded?:boolean;initialShotId?:string;disabled?:boolean;assets?:DramaAsset[]}={}){
 const div=document.createElement("div");document.body.append(div);
 const root=createRoot(div);roots.push(root);
 const changes=vi.fn<(shots:DramaShot[])=>void>();
 let updateShots:Dispatch<SetStateAction<DramaShot[]>>=()=>{};
 function Editor(){
  const [shots,setShots]=useState<DramaShot[]>(original);
  updateShots=setShots;
  return <div style={{height:720,width:1150}}>
   <DramaStoryboardFields shots={shots} episodes={episodes} assets={opts.assets??[...scenes,...characters,...props]}
    expanded={opts.expanded??true} disabled={opts.disabled??false} initialShotId={opts.initialShotId}
    onChange={next=>{changes(next);setShots(next)}}/>
  </div>;
 }
 await act(async()=>root.render(<Editor/>));
 return {div,changes,externalUpdate:async(fn:(shot:DramaShot)=>DramaShot)=>{
  await act(async()=>updateShots(current=>current.map(shot=>shot.id==="shot-1"?fn(shot):shot)));
 }};
}
async function click(target:Element|null){
 expect(target).toBeTruthy();
 await act(async()=>{(target as HTMLElement).click();});
}
async function enter(div:HTMLElement,selector:string,value:string){
 const input=div.querySelector<HTMLInputElement|HTMLTextAreaElement>(selector);
 expect(input).toBeTruthy();
 await act(async()=>{
  const proto=input?.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(input,value);
  input?.dispatchEvent(new Event("input",{bubbles:true}));
 });
}
async function select(div:HTMLElement,selector:string,value:string){
 const el=div.querySelector<HTMLSelectElement>(selector);
 expect(el).toBeTruthy();
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(el,value);
  el?.dispatchEvent(new Event("change",{bubbles:true}));
 });
}
describe("maximized storyboard editor mirrors episode localized read/edit UX",()=>{
 it("uses a shot directory and read-only surfaces for all properties with no inline inputs",async()=>{
  const {div,changes}=await mount({initialShotId:"shot-1"});
  const root=div.querySelector<HTMLElement>('[data-storyboard-editor-layout="expanded"]')!;
  const side=root.querySelector<HTMLElement>('[aria-label="镜头目录"]')!;
  const content=root.querySelector<HTMLElement>('[aria-label="当前分镜编辑区"]')!;
  expect(side.querySelectorAll('[aria-label="分镜镜头导航"] button')).toHaveLength(2);
  expect(side.querySelector('[aria-label="分镜镜头导航"] button[aria-pressed="true"]')?.textContent).toContain("全景");
  expect(content.textContent).toContain("第 1 集 · 镜头 1");
  expect(content.querySelector('[data-shot-editable-field="sourceRefs"]')).toBeNull();
  expect(content.textContent).not.toContain("原文段落 ID（每行一个）");
  for(const id of ["duration","sequence","description","shotSize","camera","action","dialogue","scene","sceneVariant","characters","props","keyProps"]){
   const item=content.querySelector<HTMLElement>(`[data-shot-editable-field="${id}"]`)!;
   expect(item?.dataset.shotFieldMode).toBe("reading");
   expect(item?.querySelector(`[data-shot-readonly="${id}"]`)).toBeTruthy();
   expect(item?.querySelector('input,textarea,select')).toBeNull();
  }
  expect(changes).not.toHaveBeenCalled();
 });
 it("shows current characters, props and scene as themed read-only fields",async()=>{
  const {div}=await mount({initialShotId:"shot-1"});
  const group=div.querySelector<HTMLElement>('[aria-label="当前镜头人物、道具与场景"]')!;
  expect(group).toBeTruthy();
  expect(group.querySelector('[data-shot-readonly="characters"]')?.textContent).toContain("小兔");
  expect(group.querySelector('[data-shot-readonly="props"]')?.textContent).toContain("花束");
  expect(group.querySelector('[data-shot-readonly="keyProps"]')?.textContent).toContain("花束");
  expect(group.querySelector('[data-shot-readonly="scene"]')?.textContent).toBe("森林");
  expect(group.querySelectorAll("input,select,textarea")).toHaveLength(0);
  await act(async()=>useThemeStore.setState({theme:"light"}));
  expect(group.querySelector<HTMLElement>('[data-shot-readonly="characters"]')?.style.background)
   .toBe(canvasThemes.light.toolbar.activeBg);
 });
 it("stages character choices, allows cancel, then saves only this shot",async()=>{
  const {div,changes}=await mount();
  await click(div.querySelector('[aria-label="编辑人物（角色造型）"]'));
  const choices=div.querySelector<HTMLElement>('[aria-label="人物（角色造型）候选"]')!;
  expect(choices.textContent).toContain("小兔 · 红衣");
  expect(choices.textContent).toContain("小龟");
  const choose=(name:string)=>[...div.querySelectorAll('[aria-label="人物（角色造型）候选"] label')].find(label=>label.textContent?.includes(name))
   ?.querySelector<HTMLInputElement>('input[type="checkbox"]')??null;
  await click(choose("小兔 · 红衣"));
  expect(changes).not.toHaveBeenCalled();
  await click(div.querySelector('[aria-label="人物（角色造型）操作"] [data-drama-action="cancel"]'));
  expect(div.querySelector('[data-shot-readonly="characters"]')?.textContent).not.toContain("红衣");
  await click(div.querySelector('[aria-label="编辑人物（角色造型）"]'));
  await click(choose("小兔 · 红衣"));
  await click(div.querySelector('[aria-label="确认人物（角色造型）"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.lastCall?.[0][0].characterVariantIds).toEqual(["rabbit","rabbit-red"]);
  expect(changes.mock.lastCall?.[0][1]).toEqual(original[1]);
  expect(changes.mock.lastCall?.[0][0].sceneId).toBe("scene-1");
  expect(div.querySelector('[data-shot-readonly="characters"]')?.textContent).toContain("红衣");
 });
 it("keeps key props within visible props; switching a shot updates displayed assets",async()=>{
  const {div,changes}=await mount();
  await click(div.querySelector('[aria-label="编辑可见道具"]'));
  const checkbox=div.querySelector<HTMLInputElement>('[aria-label="可见道具候选"] input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(true);
  await click(checkbox);
  expect(changes).not.toHaveBeenCalled();
  await click(div.querySelector('[aria-label="确认可见道具"]'));
  expect(changes.mock.lastCall?.[0][0].propIds).toEqual([]);
  expect(changes.mock.lastCall?.[0][0].keyPropIds).toEqual([]);
  await click(div.querySelector('[aria-label="编辑关键道具"]'));
  expect(div.querySelector('[aria-label="关键道具候选"]')?.textContent).toContain("暂无可选资产");
  await click(div.querySelector('[aria-label="关键道具操作"] [data-drama-action="cancel"]'));
  await click(div.querySelector('[aria-label^="选择镜头 2"]'));
  expect(div.querySelector('[data-shot-readonly="characters"]')?.textContent).toContain("小龟");
  expect(div.querySelector('[data-shot-readonly="props"]')?.textContent).toBe("未指定");
 });
 it("shows legacy unmatched IDs instead of silently dropping them",async()=>{
  const {div,changes}=await mount({assets:scenes});
  expect(div.querySelector('[data-shot-readonly="characters"]')?.textContent).toContain("待匹配 · rabbit");
  expect(div.querySelector('[data-shot-readonly="props"]')?.textContent).toContain("待匹配 · flower");
  await click(div.querySelector('[aria-label="编辑人物（角色造型）"]'));
  const legacy=div.querySelector<HTMLInputElement>('[aria-label="人物（角色造型）候选"] input[type="checkbox"]')!;
  expect(legacy.checked).toBe(true);
  expect(legacy.parentElement?.textContent).toContain("待匹配");
  await click(div.querySelector('[aria-label="人物（角色造型）操作"] [data-drama-action="cancel"]'));
  expect(changes).not.toHaveBeenCalled();
 });
 it("prevents confirming stale asset selections after an external shot update",async()=>{
  const {div,changes,externalUpdate}=await mount();
  await click(div.querySelector('[aria-label="编辑可见道具"]'));
  await click(div.querySelector('[aria-label="可见道具候选"] input[type="checkbox"]'));
  await externalUpdate(shot=>({...shot,propIds:["basket"],keyPropIds:[]}));
  expect(div.querySelector('[data-shot-editable-field="props"] [role="alert"]')?.textContent)
   .toContain("内容已在其他位置更新");
  expect(div.querySelector<HTMLButtonElement>('[aria-label="确认可见道具"]')?.disabled).toBe(true);
  expect(changes).not.toHaveBeenCalled();
  await click(div.querySelector('[aria-label="可见道具操作"] [data-drama-action="cancel"]'));
  expect(div.querySelector('[data-shot-readonly="props"]')?.textContent).toContain("篮子");
 });
 it("stages synopsis and cancels without writing; confirm updates only the active shot",async()=>{
  const {div,changes}=await mount();
  const field=div.querySelector<HTMLElement>('[data-shot-editable-field="description"]')!;
  const read=field.querySelector<HTMLElement>('[data-shot-readonly="description"]')!;
  expect(read?.style.background).toBe(canvasThemes.dark.toolbar.activeBg);
  expect(read?.classList.contains("border-l-2")).toBe(true);
  await click(field.querySelector('[aria-label="编辑画面描述"]'));
  const input=field.querySelector<HTMLTextAreaElement>('textarea[aria-label="画面描述"]')!;
  const footer=field.querySelector<HTMLElement>('[data-drama-edit-actions]')!;
  expect(input.style.background).toBe(canvasThemes.dark.node.panel);
  expect(field.style.background).toBe(canvasThemes.dark.node.fill);
  expect(field.textContent).toContain("编辑中");
  expect(footer.classList.contains("border-t")).toBe(false);
  expect(footer.querySelector('[data-drama-action="confirm"]')?.classList.contains("min-w-[68px]")).toBe(true);
  await enter(div,'textarea[aria-label="画面描述"]',"兔子突然停下");
  expect(changes).not.toHaveBeenCalled();
  await click(footer.querySelector('[data-drama-action="cancel"]'));
  expect(changes).not.toHaveBeenCalled();
  expect(field.querySelector('[data-shot-readonly="description"]')?.textContent).toBe("兔子走进森林");
  await click(field.querySelector('[aria-label="编辑画面描述"]'));
  await enter(div,'textarea[aria-label="画面描述"]',"兔子突然停下");
  await click(field.querySelector('[aria-label="确认画面描述"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.lastCall?.[0][0].description).toBe("兔子突然停下");
  expect(changes.mock.lastCall?.[0][1]).toEqual(original[1]);
  expect(changes.mock.lastCall?.[0][2]).toEqual(original[2]);
  expect(field.dataset.shotFieldMode).toBe("reading");
 });
 it("keeps simultaneous local edits isolated, validates positive durations, and reacts to theme",async()=>{
  const {div,changes}=await mount();
  await click(div.querySelector('[aria-label="编辑机位 / 运镜"]'));
  await click(div.querySelector('[aria-label="编辑镜头时长（秒）"]'));
  await enter(div,'input[aria-label="镜头时长（秒）"]',"-3");
  await enter(div,'textarea[aria-label="机位 / 运镜"]',"推镜");
  expect(div.querySelector<HTMLButtonElement>('[aria-label="确认镜头时长（秒）"]')?.disabled).toBe(true);
  await act(async()=>useThemeStore.setState({theme:"light"}));
  expect(div.querySelector<HTMLElement>('[data-shot-editable-field="camera"]')?.style.background)
   .toBe(canvasThemes.light.node.fill);
  expect(div.querySelector<HTMLTextAreaElement>('[aria-label="机位 / 运镜"]')?.style.background)
   .toBe(canvasThemes.light.node.panel);
  await click(div.querySelector('[aria-label="确认机位 / 运镜"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.lastCall?.[0][0].camera).toBe("推镜");
  expect(changes.mock.lastCall?.[0][0].durationSec).toBe(5);
  expect((div.querySelector<HTMLInputElement>('[aria-label="镜头时长（秒）"]'))?.value).toBe("-3");
  await click(div.querySelector('[aria-label="镜头时长（秒）操作"] [data-drama-action="cancel"]'));
  await click(div.querySelector('[aria-label="编辑镜头时长（秒）"]'));
  await enter(div,'input[aria-label="镜头时长（秒）"]',"9.5");
  await click(div.querySelector('[aria-label="确认镜头时长（秒）"]'));
  expect(changes.mock.lastCall?.[0][0].durationSec).toBe(9.5);
  expect(changes.mock.lastCall?.[0][0].camera).toBe("推镜");
 });
 it("applies scene changes and clears the old variant only after explicit confirmation",async()=>{
  const {div,changes}=await mount();
  await click(div.querySelector('[aria-label="编辑场景"]'));
  await select(div,'select[aria-label="场景"]',"scene-2");
  expect(changes).not.toHaveBeenCalled();
  await click(div.querySelector('[aria-label="场景操作"] [data-drama-action="cancel"]'));
  expect(div.querySelector('[data-shot-readonly="scene"]')?.textContent).toBe("森林");
  expect(div.querySelector('[data-shot-readonly="sceneVariant"]')?.textContent).toBe("早晨森林");
  await click(div.querySelector('[aria-label="编辑场景"]'));
  await select(div,'select[aria-label="场景"]',"scene-2");
  await click(div.querySelector('[aria-label="确认场景"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.lastCall?.[0][0].sceneId).toBe("scene-2");
  expect(changes.mock.lastCall?.[0][0].sceneVariantId).toBeUndefined();
  expect(div.querySelector('[data-shot-readonly="scene"]')?.textContent).toBe("河畔");
  await click(div.querySelector('[aria-label="编辑场景变体"]'));
  await select(div,'select[aria-label="场景变体"]',"variant-2");
  await click(div.querySelector('[aria-label="确认场景变体"]'));
  expect(changes.mock.lastCall?.[0][0].sceneVariantId).toBe("variant-2");
  expect(changes.mock.lastCall?.[0][0].characterVariantIds).toEqual(["rabbit"]);
 });
  it("preserves hidden source references while selecting scenes and switching shots",async()=>{
   const {div,changes}=await mount();
   expect(div.textContent).not.toContain("原文段落 ID（每行一个）");
   await click(div.querySelector('[aria-label="编辑所属场次"]'));
   await select(div,'select[aria-label="所属场次"]',"seq-2");
   await click(div.querySelector('[aria-label="确认所属场次"]'));
   expect(changes.mock.lastCall?.[0][0].sequenceId).toBe("seq-2");
   expect(changes.mock.lastCall?.[0][0].sourceRefs).toEqual(["p1"]);
   await click(div.querySelector('[aria-label="编辑对白"]'));
   await enter(div,'textarea[aria-label="对白"]',"待确认的一句台词");
   await click(div.querySelector('[aria-label^="选择镜头 2"]'));
   expect(div.querySelector('[data-shot-readonly="description"]')?.textContent).toBe("乌龟回应");
   expect(div.querySelector('textarea[aria-label="对白"]')).toBeNull();
   await click(div.querySelector('[aria-label^="选择镜头 1"]'));
   expect(div.querySelector('[data-shot-readonly="dialogue"]')?.textContent).toBe("早上好");
   expect(changes).toHaveBeenCalledTimes(1);
   await select(div,'select[aria-label="选择分镜剧集"]',"ep-2");
   expect(div.querySelector('[data-shot-readonly="description"]')?.textContent).toBe("转场");
   expect(changes).toHaveBeenCalledTimes(1);
  });
 it("blocks stale staged edits after an external update and permits an explicit reload",async()=>{
  const {div,changes,externalUpdate}=await mount();
  const field=div.querySelector<HTMLElement>('[data-shot-editable-field="description"]')!;
  await click(field.querySelector('[aria-label="编辑画面描述"]'));
  await enter(div,'textarea[aria-label="画面描述"]',"本地未确认的文字");
  await externalUpdate(shot=>({...shot,description:"他人更新的镜头文字"}));
  expect(field.querySelector('[role="alert"]')?.textContent).toContain("内容已在其他位置更新");
  expect(field.querySelector<HTMLButtonElement>('[data-drama-action="confirm"]')?.disabled).toBe(true);
  expect(changes).not.toHaveBeenCalled();
  await click(field.querySelector('[data-drama-action="cancel"]'));
  expect(field.querySelector('[data-shot-readonly="description"]')?.textContent).toBe("他人更新的镜头文字");
  await click(field.querySelector('[aria-label="编辑画面描述"]'));
  await enter(div,'textarea[aria-label="画面描述"]',"新内容");
  await click(field.querySelector('[aria-label="确认画面描述"]'));
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.lastCall?.[0][0].description).toBe("新内容");
 });
 it("keeps compact selectors available and disables edit actions during generation",async()=>{
  const {div,changes}=await mount({expanded:false,disabled:true});
  expect(div.querySelector('[data-storyboard-editor-layout="compact"]')).toBeTruthy();
  expect(div.querySelectorAll('select')).toHaveLength(2);
  expect(div.querySelector<HTMLButtonElement>('[aria-label="编辑画面描述"]')?.disabled).toBe(true);
  expect(changes).not.toHaveBeenCalled();
 });
});
