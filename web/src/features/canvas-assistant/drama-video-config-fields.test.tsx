// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import type {DramaShotProduction,DramaVideoInput} from "./drama-pipeline-media";

const mocks=vi.hoisted(()=>({
 config:{videoSeconds:6,videoRatio:"16:9",videoModel:"test",comfyWorkflowDefaults:{}},
 audit:vi.fn(),capabilities:vi.fn(),
}));
vi.mock("@/stores/use-config-store",()=>({useEffectiveConfig:()=>mocks.config}));
vi.mock("./drama-media-preflight",()=>({prepareDramaProduction:async(input:DramaVideoInput)=>input}));
vi.mock("./drama-production-audit",()=>({
 dramaMediaModes:[
  {id:"text_to_video",label:"纯文本"},{id:"first_frame",label:"首帧"},
  {id:"first_last_frame",label:"首尾帧"},{id:"omni_reference",label:"资产参考图"},
  {id:"grid",label:"分镜网格参考图"},
 ],
 listDramaProductionCapabilities:async()=>{
  mocks.capabilities();
  return {engine:"comfy",channel:"本地 ComfyUI",model:"测试模型",
   modes:["text_to_video","first_frame","first_last_frame","omni_reference","grid"].map(mode=>({
    mode,label:mode,available:true,
   }))};
 },
 auditDramaProduction:async(input:DramaVideoInput)=>{
  mocks.audit(input);
  return {ready:true,input,mode:input.mode??"text_to_video",durationSeconds:6,aspectRatio:"16:9",
   referenceCount:input.referenceImages.length,referenceKeys:[],missingReferenceIds:[],
   prompt:input.prompt,engine:"comfy"};
 },
}));
import {DramaVideoConfigFields} from "./drama-video-config-fields";

const inputs:DramaVideoInput[]=[
 {shot:{id:"s1",episodeId:"e1",order:1,description:"兔子走进森林",shotSize:"全景",
  characterVariantIds:[],propIds:[],keyPropIds:[]},prompt:"兔子走进森林",referenceImages:[]},
 {shot:{id:"s2",episodeId:"e1",order:2,description:"乌龟登场",shotSize:"近景",
  characterVariantIds:[],propIds:[],keyPropIds:[]},prompt:"乌龟登场",referenceImages:[]},
 {shot:{id:"s3",episodeId:"e2",order:1,description:"来到河边",
  characterVariantIds:[],propIds:[],keyPropIds:[]},prompt:"来到河边",referenceImages:[]},
];
const episodes=[{id:"e1",title:"森林相遇"},{id:"e2",title:"河边远行"}];
const imageKey="cas:"+"a".repeat(64);
const roots:Root[]=[];
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);mocks.audit.mockReset();mocks.capabilities.mockReset();});
afterEach(async()=>{for(const root of roots)await act(async()=>root.unmount());roots.length=0;vi.unstubAllGlobals();document.body.replaceChildren();});

async function mount(options:{
 expanded?:boolean;theme?:"dark"|"light";initialShotId?:string;
 configs?:ReadonlyMap<string,CanvasNodeData>;onPickImage?:(cb:(key:string)=>void)=>void;
}={}){
 const el=document.createElement("div");document.body.append(el);
 const root=createRoot(el);roots.push(root);
 const change=vi.fn<(shotId:string,value:DramaShotProduction)=>void>();
 const action=vi.fn<(input:DramaVideoInput,existing?:CanvasNodeData)=>void>();
 const createSelected=vi.fn<(items:DramaVideoInput[])=>void>();
 const createBatch=vi.fn<(_ids:string[])=>Promise<void>>(async()=>{});
 const refresh=vi.fn<(id:string,input:DramaVideoInput,fields:{prompt:boolean;duration:boolean;references?:boolean;overwrite:boolean})=>void>();
 function TestView(){
  const [production,setProduction]=useState<Record<string,DramaShotProduction>>({});
  return <div style={{width:1100,height:650}}>
   <DramaVideoConfigFields inputs={inputs} episodes={episodes} configs={options.configs}
    missingCount={inputs.length-(options.configs?.size??0)} missingFor={()=>[]}
    hasUnconfirmedChanges={false} disabled={false} theme={canvasThemes[options.theme??"dark"]}
    onCreateSelected={createSelected} onCreateBatch={createBatch}
    onAction={action} onRefresh={refresh}
    expanded={options.expanded??true} initialShotId={options.initialShotId}
    production={production} onPickImage={options.onPickImage??(cb=>cb(imageKey))}
    onProductionChange={(id,value)=>{change(id,value);setProduction(curr=>({...curr,[id]:value}));}}/>
   </div>;
 }
 await act(async()=>{root.render(<TestView/>);await Promise.resolve();});
 return {el,root,change,action,createSelected,createBatch,refresh};
}
async function click(el:Element|null|undefined){
 expect(el).toBeTruthy();
 await act(async()=>{(el as HTMLElement).click();await Promise.resolve();});
}
async function choose(el:HTMLSelectElement|null,value:string){
 expect(el).toBeTruthy();
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(el,value);
  el!.dispatchEvent(new Event("change",{bubbles:true}));
 });
}

it.each(["dark","light"] as const)("matches storyboard split-pane, directory and read-only video mode in %s theme",async theme=>{
 const {el}=await mount({theme,configs:new Map([["s2",{id:"cfg-2",metadata:{}} as CanvasNodeData]])});
 const root=el.querySelector<HTMLElement>('[data-video-config-layout="expanded"]')!;
 expect(root).toBeTruthy();
 expect(root.classList.contains("lg:grid-cols-[minmax(220px,0.33fr)_minmax(0,1fr)]")).toBe(true);
 const dir=root.querySelector<HTMLElement>('[aria-label="视频配置镜头目录"]')!;
 const main=root.querySelector<HTMLElement>('[aria-label="当前视频配置编辑区"]')!;
 expect(dir.style.background).toBe(canvasThemes[theme].node.panel);
 expect(main.style.background).toBe(canvasThemes[theme].node.panel);
 expect(dir.querySelectorAll('nav[aria-label="视频配置镜头导航"] button')).toHaveLength(2);
 expect(dir.textContent).toContain("已配置");
 expect(dir.textContent).toContain("待配置");
 expect(main.textContent).toContain("第 1 集 · 镜头 1");
 expect(main.querySelector('[data-storyboard-video-description]')?.textContent).toContain("兔子");
 expect(main.querySelector('[data-video-mode-field="reading"]')).toBeTruthy();
 expect(main.querySelector('select[aria-label="视频输入模式"]')).toBeNull();
 expect(main.querySelector<HTMLDetailsElement>('details[aria-label="逐镜媒体输入预检"]')?.open).toBe(false);
 expect(main.querySelector<HTMLDetailsElement>('details[aria-label="批量创建视频配置"]')?.open).toBe(false);
 expect(main.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
});
it("stages mode changes and cancels without writes; choosing an image explicitly commits mode and image",async()=>{
 const {el,change}=await mount();
 await click(el.querySelector('button[aria-label="编辑视频输入模式"]'));
 const field=el.querySelector<HTMLElement>('[aria-label="视频输入模式区域"]')!;
 expect(field.dataset.videoModeField).toBe("editing");
 await choose(field.querySelector('select[aria-label="视频输入模式"]'),"first_frame");
 await click(field.querySelector('button[data-drama-action="cancel"]'));
 expect(change).not.toHaveBeenCalled();
 expect(field.textContent).toContain("纯文本");
 await click(field.querySelector('button[aria-label="编辑视频输入模式"]'));
 await choose(field.querySelector('select[aria-label="视频输入模式"]'),"first_frame");
 expect(field.textContent).toContain("从画布选择图片后，会立即保存当前输入模式");
 expect(change).not.toHaveBeenCalled();
 await click(field.querySelector("button:not([data-drama-action]):not([aria-label])"));
 expect(change).toHaveBeenCalledTimes(1);
 expect(change.mock.lastCall?.[0]).toBe("s1");
 expect(change.mock.lastCall?.[1]).toMatchObject({mode:"first_frame",gridInput:false,firstFrame:imageKey});
 expect(field.dataset.videoModeField).toBe("reading");
 expect(field.textContent).toContain("首帧：已选择");
});
it("confirms a mode without image selection only after explicit confirmation",async()=>{
 const {el,change}=await mount();
 await click(el.querySelector('button[aria-label="编辑视频输入模式"]'));
 await choose(el.querySelector('select[aria-label="视频输入模式"]'),"omni_reference");
 expect(change).not.toHaveBeenCalled();
 await click(el.querySelector('button[aria-label="确认视频输入模式"]'));
 expect(change).toHaveBeenCalledTimes(1);
 expect(change.mock.lastCall?.[1]).toMatchObject({mode:"omni_reference",gridInput:false});
 expect(el.querySelector('[data-video-mode-field="reading"]')?.textContent).toContain("资产参考图");
});
it("preserves canvas image picks even after maximized editor unmount",async()=>{
 let pending:((key:string)=>void)|undefined;
 const {el,root,change}=await mount({onPickImage:callback=>{pending=callback;}});
 await click(el.querySelector('[aria-label="编辑视频输入模式"]'));
 await choose(el.querySelector('select[aria-label="视频输入模式"]'),"first_frame");
 await click([...el.querySelectorAll<HTMLButtonElement>('[data-video-mode-field="editing"] button')]
  .find(button=>button.textContent==="选择首帧"));
 expect(change).not.toHaveBeenCalled();
 expect(pending).toBeTruthy();
 await act(async()=>root.unmount());
 roots.splice(roots.indexOf(root),1);
 await act(async()=>pending?.(imageKey));
 expect(change).toHaveBeenCalledTimes(1);
 expect(change.mock.lastCall?.[0]).toBe("s1");
 expect(change.mock.lastCall?.[1]).toMatchObject({mode:"first_frame",gridInput:false,firstFrame:imageKey});
});
it("keeps compact video controls and original immediate-save behavior",async()=>{
 const {el,change}=await mount({expanded:false});
 expect(el.querySelector('[data-video-config-layout="compact"]')).toBeTruthy();
 expect(el.querySelector('[aria-label="视频配置镜头目录"]')).toBeNull();
 expect(el.querySelector('select[aria-label="视频输入模式"]')).toBeTruthy();
 await choose(el.querySelector('select[aria-label="视频输入模式"]'),"omni_reference");
 expect(change.mock.lastCall?.[1].mode).toBe("omni_reference");
});
it("keeps shot navigation isolated and discards an unconfirmed mode change",async()=>{
 const {el,change}=await mount({initialShotId:"s1"});
 await click(el.querySelector('[aria-label="编辑视频输入模式"]'));
 await choose(el.querySelector('select[aria-label="视频输入模式"]'),"first_last_frame");
 await click(el.querySelector('[aria-label^="选择视频镜头 2"]'));
 expect(el.querySelector('[data-video-mode-field="editing"]')).toBeNull();
 expect(el.querySelector('[data-storyboard-video-description]')?.textContent).toContain("乌龟");
 expect(change).not.toHaveBeenCalled();
 await click(el.querySelector('[aria-label^="选择视频镜头 1"]'));
 expect(el.querySelector('[data-video-mode-field="reading"]')?.textContent).toContain("纯文本");
 await choose(el.querySelector('select[aria-label="选择视频配置剧集"]'),"e2");
 expect(el.querySelector('[data-storyboard-video-description]')?.textContent).toContain("河边");
 expect(el.querySelectorAll('nav[aria-label="视频配置镜头导航"] button')).toHaveLength(1);
});
it("preserves create config, batch create and batch group actions behind collapsible panels",async()=>{
 const {el,action,createSelected}=await mount();
 await click(el.querySelector('button:not([disabled]).ant-btn-primary, button:not([disabled]).ant-btn'));
 expect(action).toHaveBeenCalledTimes(1);
 expect(action.mock.lastCall?.[0].shot.id).toBe("s1");
 await click(el.querySelector('details[aria-label="批量创建视频配置"] summary'));
 const checks=el.querySelectorAll<HTMLInputElement>('details[aria-label="批量创建视频配置"] input[type="checkbox"]');
 expect(checks.length).toBe(2);
 await click(checks[0]);
 await click([...el.querySelectorAll<HTMLButtonElement>('details[aria-label="批量创建视频配置"] button')]
  .find(button=>button.textContent?.includes("创建所选视频配置")));
 expect(createSelected).toHaveBeenCalledTimes(1);
 expect(createSelected.mock.lastCall![0][0].shot.id).toBe("s1");
});
it("keeps configured shot open, selectively adopt updates and local Comfy batch grouping",async()=>{
 const source={basePrompt:"开场",prompt:"开场",shot:"{}",referenceKeys:[]};
 const cfg=(id:string)=>({id,metadata:{dramaVideoSource:source}} as unknown as CanvasNodeData);
 const {el,action,refresh,createBatch}=await mount({configs:new Map([["s1",cfg("cfg-1")],["s2",cfg("cfg-2")]])});
 await click([...el.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="打开配置"));
 expect(action).toHaveBeenCalledTimes(1);
 expect(action.mock.lastCall?.[1]?.id).toBe("cfg-1");
 await click(el.querySelector('details:not([aria-label]) > summary')!);
 // Only the selected fields are adopted; manual changes are not overwritten by default.
 await click([...el.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="采用所选更新"));
 expect(refresh).toHaveBeenCalledTimes(1);
 expect(refresh.mock.lastCall?.[0]).toBe("cfg-1");
 expect(refresh.mock.lastCall?.[2]).toMatchObject({prompt:true,duration:false,references:false,overwrite:false});
 await click(el.querySelector('details[aria-label="P3 选镜头组建批量生成"] summary'));
 const checks=el.querySelectorAll<HTMLInputElement>('details[aria-label="P3 选镜头组建批量生成"] input[type="checkbox"]');
 expect(checks).toHaveLength(2);
 await click(checks[0]);await click(checks[1]);
 await click([...el.querySelectorAll<HTMLButtonElement>('details[aria-label="P3 选镜头组建批量生成"] button')]
  .find(button=>button.textContent?.includes("组建所选镜头")));
 expect(createBatch).toHaveBeenCalledWith(["s1","s2"]);
});
