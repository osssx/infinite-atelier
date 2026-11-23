// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {DramaShot,DramaAsset} from "./canvas-drama-pipeline";

const api=vi.hoisted(()=>({read:vi.fn(),digest:"a".repeat(64),current:null as DramaShot|null}));
vi.mock("@/stores/use-theme-store",async()=>({
 useThemeStore:(await import("zustand")).create<{theme:"light"|"dark"}>(()=>({theme:"dark"}))
}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:(...args:unknown[])=>api.read(...args)}));
import {DramaStoryboardFields} from "./drama-storyboard-fields";

const base:DramaShot={
 id:"shot-1",episodeId:"episode-1",order:1,description:"原始镜头",
 sceneId:"scene-old",sceneVariantId:"variant-old",sequenceId:"sequence-1",
 characterVariantIds:["rabbit"],propIds:["flower"],keyPropIds:["flower"],
 shotSize:"全景",camera:"俯拍",action:"向前走",dialogue:"你好",durationSec:5
};
const episodes=[{id:"episode-1",title:"故事",sequences:[
 {id:"sequence-1",title:"早晨"},{id:"sequence-2",title:"傍晚"}]}];
const assets:DramaAsset[]=[
 {kind:"scene",id:"scene-old",name:"森林",description:"",sourceRefs:[],
  variants:[{id:"variant-old",name:"早晨",description:""}]},
 {kind:"scene",id:"scene-new",name:"河畔",description:"",sourceRefs:[]},
 {kind:"prop",id:"flower",name:"花束",description:"",sourceRefs:[]},
 {kind:"prop",id:"basket",name:"篮子",description:"",sourceRefs:[]},
 {kind:"character",id:"rabbit",name:"兔子",description:"",sourceRefs:[]},
];
const roots:Root[]=[];
beforeEach(()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
 api.read.mockReset();api.current={...base};
 api.read.mockImplementation(async(path:string)=>{
  expect(path).toContain("draft=true");
  expect(path).toContain("entryId=shot-1");
  expect(path).toContain("limit=1");
  return {entries:[api.current],entryDigests:[{id:"shot-1",digest:api.digest}]};
 });
});
afterEach(async()=>{
 for(const root of roots)await act(async()=>root.unmount());
 roots.length=0;vi.unstubAllGlobals();document.body.replaceChildren();
});
async function mount(onPatchShot=vi.fn<(...args:[string,string,Record<string,unknown>])=>Promise<void>>(async()=>{})){
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 const full=vi.fn();
 function View(){
  const [shots,setShots]=useState<DramaShot[]>([base]);
  return <DramaStoryboardFields shots={shots} episodes={episodes} assets={assets}
   expanded disabled={false} projectId="project-1" nodeId="board-1"
   onPatchShot={async(id,digest,changes)=>{
    await onPatchShot(id,digest,changes);
    // Simulate the store AND authoritative payload refresh after the CAS receipt.
    const updated={...api.current,...Object.fromEntries(Object.entries(changes)
      .filter(([,value])=>value!==null)),...Object.fromEntries(Object.entries(changes)
      .filter(([,value])=>value===null).map(([key])=>[key,undefined]))} as DramaShot;
    api.current=updated;
    setShots([updated]);
   }}
   onReloadShot={async()=>{setShots([{...api.current!}]);}}
   onChange={full}/>;
 }
 await act(async()=>{root.render(<View/>);await Promise.resolve();});
 return {container,full,onPatchShot};
}
async function click(el:Element|null|undefined){
 expect(el).toBeTruthy();
 await act(async()=>{(el as HTMLElement).click();await Promise.resolve();});
}
async function setText(input:HTMLInputElement|HTMLTextAreaElement,value:string){
 await act(async()=>{
  const proto=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,"value")!.set!.call(input,value);
  input.dispatchEvent(new Event("input",{bubbles:true}));
 });
}
async function select(el:HTMLSelectElement,value:string){
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(el,value);
  el.dispatchEvent(new Event("change",{bubbles:true}));
 });
}
it("fetches the digest and patches only the selected description without full-draft onChange",async()=>{
 const {container,onPatchShot,full}=await mount();
 expect(api.read).toHaveBeenCalledTimes(1);
 expect(container.querySelector('[aria-label="当前镜头 CAS 状态"]')?.textContent).toContain("精确保存");
 await click(container.querySelector('button[aria-label="编辑画面描述"]'));
 const editor=container.querySelector<HTMLTextAreaElement>('textarea[aria-label="画面描述"]')!;
 await setText(editor,"只修改本镜头");
 expect(full).not.toHaveBeenCalled();
 await click(container.querySelector('button[aria-label="确认画面描述"]'));
 expect(onPatchShot).toHaveBeenCalledWith("shot-1",api.digest,{description:"只修改本镜头"});
 expect(full).not.toHaveBeenCalled();
 expect(container.querySelector('[data-shot-readonly="description"]')?.textContent).toContain("只修改本镜头");
});
it("retains unsaved field text after a conflicting CAS and permits explicit version reload",async()=>{
 const conflict=vi.fn(async()=>{throw Error("drama_candidate_conflict");});
 const {container,full}=await mount(conflict);
 await click(container.querySelector('button[aria-label="编辑画面描述"]'));
 await setText(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="画面描述"]')!,"我的修改");
 await click(container.querySelector('button[aria-label="确认画面描述"]'));
 expect(container.querySelector('[data-shot-field-mode="editing"] textarea[aria-label="画面描述"]')?.getAttribute("value")).not.toBe("原始镜头");
 expect(container.querySelector('textarea[aria-label="画面描述"]')).toBeTruthy();
 expect(container.querySelector('[aria-label="当前镜头 CAS 状态"]')?.textContent).toContain("未覆盖服务器数据");
 expect(full).not.toHaveBeenCalled();
 await click([...container.querySelectorAll("button")].find(button=>button.textContent?.includes("重新加载镜头内容")));
 expect(api.read).toHaveBeenCalledTimes(2);
});

it("does not accept a new digest for stale local data; reload replaces local shot before enabling edits",async()=>{
 api.current={...base,description:"远端已编辑"};
 const {container,onPatchShot}=await mount();
 expect(container.querySelector('[aria-label="当前镜头 CAS 状态"]')?.textContent)
  .toContain("服务器镜头内容已更新");
 expect(container.querySelector<HTMLButtonElement>('[aria-label="编辑画面描述"]')?.disabled).toBe(true);
 expect(onPatchShot).not.toHaveBeenCalled();
 await click([...container.querySelectorAll("button")].find(button=>button.textContent?.includes("重新加载镜头内容")));
 expect(container.querySelector('[data-shot-readonly="description"]')?.textContent).toContain("远端已编辑");
 expect(container.querySelector<HTMLButtonElement>('[aria-label="编辑画面描述"]')?.disabled).toBe(false);
});
it("updates scene and variant atomically, and clears nullable optional fields",async()=>{
 const {container,onPatchShot}=await mount();
 await click(container.querySelector('[aria-label="编辑场景"]'));
 await select(container.querySelector<HTMLSelectElement>('select[aria-label="场景"]')!,"scene-new");
 await click(container.querySelector('button[aria-label="确认场景"]'));
 expect(onPatchShot).toHaveBeenLastCalledWith("shot-1",api.digest,
  {sceneId:"scene-new",sceneVariantId:null});
 await click(container.querySelector('button[aria-label="编辑机位 / 运镜"]'));
 await setText(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="机位 / 运镜"]')!,"");
 await click(container.querySelector('button[aria-label="确认机位 / 运镜"]'));
 expect(onPatchShot).toHaveBeenLastCalledWith("shot-1",api.digest,{camera:null});
});
it("cleans key prop IDs together when removing a visible prop",async()=>{
 const {container,onPatchShot}=await mount();
 await click(container.querySelector('[aria-label="编辑可见道具"]'));
 const checked=container.querySelector<HTMLInputElement>('[aria-label="可见道具候选"] input[type="checkbox"]:checked')!;
 await click(checked);
 await click(container.querySelector('button[aria-label="确认可见道具"]'));
 expect(onPatchShot).toHaveBeenLastCalledWith("shot-1",api.digest,{propIds:[],keyPropIds:[]});
});
it("pages a 46-shot directory from revision-scope and preserves initial shot focus",async()=>{
 const many=Array.from({length:46},(_,index):DramaShot=>({
  ...base,id:"shot-"+(index+1),order:index+1,description:"镜头描述 "+(index+1)
 }));
 api.read.mockImplementation(async(path:string)=>{
  const url=new URL(path,"http://local");
  const entryId=url.searchParams.get("entryId");
  if(entryId){
   const shot=many.find(item=>item.id===entryId);
   return {entries:shot?[shot]:[],entryDigests:shot?[{id:shot.id,digest:api.digest}]:[]};
  }
  const offset=Number(url.searchParams.get("offset")??0);
  const limit=Number(url.searchParams.get("limit")??15);
  return {total:many.length,entries:many.slice(offset,offset+limit),entryDigests:[]};
 });
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 await act(async()=>{
  root.render(<DramaStoryboardFields shots={many} episodes={episodes} assets={assets}
   expanded disabled={false} projectId="project-1" nodeId="board-1" initialShotId="shot-31"
   onPatchShot={async()=>{}} onChange={()=>{}}/>);
  await Promise.resolve();
 });
 const nav=container.querySelector<HTMLElement>('[aria-label="分镜镜头导航"]')!;
 expect(container.querySelector('[data-drama-scoped-directory]')).toBeTruthy();
 expect(nav.querySelectorAll("button")).toHaveLength(15);
 expect(nav.querySelector('button[aria-label^="选择镜头 31"]')).toBeTruthy();
 expect(nav.querySelector('button[aria-label^="选择镜头 1"]')).toBeNull();
 expect(container.querySelector('[data-drama-scoped-directory]')?.textContent).toContain("31–45 / 46");
 expect(api.read.mock.calls.some(([path])=>String(path).includes("offset=30&limit=15"))).toBe(true);
 await click([...container.querySelectorAll<HTMLButtonElement>('[data-drama-scoped-directory] button')]
  .find(button=>button.textContent==="下一页"));
 expect(nav.querySelectorAll("button")).toHaveLength(1);
 expect(nav.querySelector('button[aria-label^="选择镜头 46"]')).toBeTruthy();
 expect(container.querySelector('[aria-label="当前分镜编辑区"]')?.textContent).toContain("镜头 46");
});
it("falls back to the loaded directory slice when paged API is temporarily unavailable",async()=>{
 const many=Array.from({length:30},(_,index):DramaShot=>({
  ...base,id:"shot-"+(index+1),order:index+1,description:"镜头 "+(index+1)
 }));
 api.read.mockImplementation(async(path:string)=>{
  const url=new URL(path,"http://local");
  const entryId=url.searchParams.get("entryId");
  if(entryId)return {entries:many.filter(shot=>shot.id===entryId),
   entryDigests:[{id:entryId,digest:api.digest}]};
  throw Error("paged_service_unavailable");
 });
 const container=document.createElement("div");document.body.append(container);
 const root=createRoot(container);roots.push(root);
 await act(async()=>{
  root.render(<DramaStoryboardFields shots={many} episodes={episodes} assets={assets}
   expanded disabled={false} projectId="project-1" nodeId="board-1"
   onPatchShot={async()=>{}} onChange={()=>{}}/>);
  await Promise.resolve();
 });
 expect(container.querySelectorAll('[aria-label="分镜镜头导航"] button')).toHaveLength(15);
 expect(container.querySelector('[data-drama-scoped-directory]')?.textContent)
  .toContain("分页服务不可用");
});
