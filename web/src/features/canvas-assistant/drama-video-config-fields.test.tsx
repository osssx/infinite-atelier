// @vitest-environment happy-dom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {CanvasNodeData} from "@/types/canvas";
import {canvasThemes} from "@/lib/canvas-theme";
import type {DramaShotProduction,DramaVideoInput} from "./drama-pipeline-media";

const mocks=vi.hoisted(()=>({
 config:{videoSeconds:6,videoRatio:"16:9",videoModel:"test",comfyWorkflowDefaults:{},channels:[{id:"api",name:"测试在线渠道",models:[{name:"video-v1",capability:"video"},{name:"text-v1",capability:"text"}]}]},
 audit:vi.fn(),capabilities:vi.fn(),
}));
vi.mock("@/stores/use-config-store",()=>({useEffectiveConfig:()=>mocks.config,encodeChannelModel:(channel:string,model:string)=>channel+"::"+model,modelOptionLabel:(_config:unknown,model:string)=>model}));
vi.mock("@/features/comfy-workflow/template-registry",()=>({listComfyTemplates:async()=>[
 {id:"video-template",revision:"pinned",name:"本地视频模板",mediaUseCase:{channel:"video"}},
 {id:"image-template",revision:"pinned",name:"图片模板",mediaUseCase:{channel:"image"}}
]}));
vi.mock("./drama-media-preflight",()=>({prepareDramaProduction:async(input:DramaVideoInput)=>input}));
vi.mock("./drama-production-audit",()=>({
 dramaMediaModes:[
  {id:"text_to_video",label:"纯文本"},{id:"first_frame",label:"首帧"},
  {id:"first_last_frame",label:"首尾帧"},{id:"omni_reference",label:"资产参考图"},
  {id:"grid",label:"分镜网格参考图"},
 ],
 listDramaProductionCapabilities:async(_config:unknown,setting?:DramaShotProduction)=>{
  mocks.capabilities(setting);
  const online=setting?.target?.kind==="online";
  return {engine:online?"online":"comfy",channel:online?"测试在线渠道":"本地 ComfyUI",model:online?"video-v1":"测试模型",
   modes:["text_to_video","first_frame","first_last_frame","omni_reference","grid"].map(mode=>({
    mode,label:mode,available:!online||mode==="text_to_video",
    parameters:online?[{id:"duration_seconds",mode:"adjustable",type:"number",min:3,max:10,step:1},{id:"aspect_ratio",mode:"adjustable",type:"enum",values:["16:9","9:16"]}]:[],
   }))};
 },
 auditDramaProduction:async(input:DramaVideoInput)=>{
  mocks.audit(input);
  return {ready:true,input,mode:input.mode??"text_to_video",durationSeconds:6,aspectRatio:"16:9",
   referenceCount:input.referenceImages.length,referenceKeys:[],missingReferenceIds:[],
   prompt:input.prompt,engine:"comfy"};
 },
}));
import {DramaVideoConfigFields,DramaBatchConfigPanel} from "./drama-video-config-fields";
import {DramaFeedbackContext,useDramaFeedbackController,DramaFeedbackNotices} from "./drama-feedback";

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
 expanded?:boolean;theme?:"dark"|"light";initialShotId?:string;embedded?:boolean;confirmedInput?:boolean;
 configs?:ReadonlyMap<string,CanvasNodeData>;onPickImage?:(cb:(key:string)=>void)=>void;
 production?:Record<string,DramaShotProduction>;productionStyle?:string;
 images?:{key:string;title:string}[];onPendingChange?:(key:string,save:(()=>Promise<void>)|null)=>void;onWaitForSave?:()=>Promise<void>;
}={}){
 const el=document.createElement("div");document.body.append(el);
 const root=createRoot(el);roots.push(root);
 const change=vi.fn<(shotId:string,value:DramaShotProduction)=>void>();
 const action=vi.fn<(input:DramaVideoInput,existing?:CanvasNodeData)=>void>();
 const createSelected=vi.fn<(items:DramaVideoInput[])=>void>();
 const createBatch=vi.fn<(_ids:string[])=>Promise<void>>(async()=>{});
 const refresh=vi.fn<(id:string,input:DramaVideoInput,fields:{prompt:boolean;duration:boolean;references?:boolean;overwrite:boolean})=>void>();
 function TestView(){
  const [production,setProduction]=useState<Record<string,DramaShotProduction>>(options.production??{});
  const feedback=useDramaFeedbackController();
  return <DramaFeedbackContext.Provider value={feedback.context}><div style={{width:1100,height:650}}>
   <DramaVideoConfigFields inputs={inputs} episodes={episodes} configs={options.configs}
    missingCount={inputs.length-(options.configs?.size??0)} missingFor={()=>[]}
    hasUnconfirmedChanges={false} disabled={false} theme={canvasThemes[options.theme??"dark"]}
    onCreateSelected={createSelected} onCreateBatch={createBatch}
    onAction={action} onRefresh={refresh}
    expanded={options.expanded??true} initialShotId={options.initialShotId} embedded={options.embedded} confirmedInput={options.confirmedInput}
    production={production} productionStyle={options.productionStyle} onPickImage={options.onPickImage??(cb=>cb(imageKey))}
    images={options.images} onPendingChange={options.onPendingChange} onWaitForSave={options.onWaitForSave}
    onProductionChange={(id,value)=>{change(id,value);setProduction(curr=>({...curr,[id]:value}));}}/>
   <DramaFeedbackNotices notices={feedback.notices} clear={feedback.clear} theme={canvasThemes[options.theme??"dark"]}/></div></DramaFeedbackContext.Provider>;
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
 expect(main.querySelector('[aria-label="视频配置页面"] button[aria-pressed="true"]')?.textContent).toBe("生成设置");
 expect(main.querySelector('[aria-label="视频提示词"]')).toBeNull();
 expect(main.querySelector<HTMLDetailsElement>('details[aria-label="批量创建视频配置"]')?.open).toBe(false);
 expect(main.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
});
it("stages channel selection, refreshes capabilities, preserves media settings and opens separate tabs",async()=>{
 const {el,change,action}=await mount({embedded:true});
 const tab=(text:string)=>[...el.querySelectorAll('[aria-label="视频配置页面"] button')].find(b=>b.textContent===text);
 await click(tab("提示词"));
 expect(el.querySelector('[aria-label="视频提示词"]')?.textContent).toContain("兔子走进森林");
 await click(tab("参考素材"));
 expect(el.querySelector('[aria-label="视频参考素材"]')).toBeTruthy();
 await click(tab("生成设置"));
 await click(el.querySelector('[aria-label="编辑视频输入模式"]'));
 const picker=el.querySelector<HTMLSelectElement>('select[aria-label="视频渠道"]')!;
 expect(picker.textContent).toContain("本地视频模板");
 expect(picker.textContent).not.toContain("图片模板");
 expect(picker.textContent).not.toContain("text-v1");
 await choose(el.querySelector('select[aria-label="视频输入模式"]'),"first_frame");
 const online=JSON.stringify({kind:"online",modelOption:"api::video-v1"});
 await choose(picker,online);
 const mode=el.querySelector<HTMLSelectElement>('select[aria-label="视频输入模式"]')!;
 expect(mode.value).toBe("first_frame");
 expect([...mode.options].find(o=>o.value==="first_frame")?.disabled).toBe(true);
 expect((tab("提示词") as HTMLButtonElement).disabled).toBe(true);
 expect(change).not.toHaveBeenCalled();
 await choose(mode,"text_to_video");
 const duration=el.querySelector<HTMLInputElement>('input[aria-label="视频时长"]')!;
 expect(duration.max).toBe("10");
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(duration,"8");duration.dispatchEvent(new Event("input",{bubbles:true}));});
 await choose(el.querySelector('select[aria-label="视频画幅"]'),"9:16");
 await click(el.querySelector('[aria-label="确认视频输入模式"]'));
 expect(change).toHaveBeenCalledTimes(1);
 expect(change.mock.lastCall?.[1]).toMatchObject({target:{kind:"online",modelOption:"api::video-v1"},mode:"text_to_video",durationSec:8,aspectRatio:"9:16"});
 await click(el.querySelector('[aria-label="编辑视频输入模式"]'));
 await choose(el.querySelector('select[aria-label="视频渠道"]'),JSON.stringify({kind:"comfy",templateId:"video-template",templateRevision:"pinned"}));
 await click(el.querySelector('[data-drama-action="cancel"]'));
 expect(change).toHaveBeenCalledTimes(1);
 expect(el.textContent).toContain("测试在线渠道");
 await click([...el.querySelectorAll("button")].find(b=>b.textContent==="创建视频配置"));
 expect(action).toHaveBeenCalledTimes(1);
});

it.each(["dark","light"] as const)("edits and restores video prompts using the shared pending guard (%s)",async theme=>{
 const pending=new Map<string,()=>Promise<void>>();
 const wait=vi.fn(async()=>{});
 const {el,change}=await mount({theme,productionStyle:"水彩",onWaitForSave:wait,onPendingChange:(key,save)=>{if(save)pending.set(key,save);else pending.delete(key);}});
 const button=(text:string)=>[...el.querySelectorAll("button")].find(b=>b.textContent?.trim()===text);
 const editor=()=>el.querySelector('[data-video-prompt-editor]')!;
 const type=async(value:string)=>{
  const field=editor().querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});
 };
 await click(button("提示词"));
 expect(editor().textContent).toContain("影片风格：水彩");
 await click(editor().querySelector('[aria-label="编辑视频提示词"]'));
 expect(editor().querySelector("textarea")?.getAttribute("rows")).toBe("12");
 await type("  ");
 expect(editor().querySelector<HTMLButtonElement>('[aria-label="保存视频提示词"]')?.disabled).toBe(true);
 await type("@[node:bad]");
 expect(editor().textContent).toContain("内部节点引用");
 await type("人工提示词\n保持留白");
 expect(pending.has("video-prompt:s1")).toBe(true);
 expect((button("生成设置") as HTMLButtonElement).disabled).toBe(true);
 expect((button("创建视频配置") as HTMLButtonElement).disabled).toBe(true);
 expect(el.querySelector<HTMLButtonElement>('[aria-label^="选择视频镜头 2"]')?.disabled).toBe(true);
 expect(change).not.toHaveBeenCalled();
 await click(editor().querySelector('[data-drama-action="cancel"]'));
 expect(change).not.toHaveBeenCalled();expect(pending.size).toBe(0);
 await click(editor().querySelector('[aria-label="编辑视频提示词"]'));
 await type("人工提示词\n保持留白");
 await act(async()=>{await pending.get("video-prompt:s1")!();});
 expect(change.mock.lastCall?.[1]).toMatchObject({mode:"text_to_video",promptOverride:{text:"人工提示词\n保持留白",sourceFingerprint:JSON.stringify(["兔子走进森林","水彩","text_to_video",false])}});
 expect(wait).toHaveBeenCalledTimes(1);
 expect(editor().querySelector("pre")?.textContent).toBe("人工提示词\n保持留白");
 expect(pending.size).toBe(0);
 await click(button("恢复自动生成"));
 expect(editor().querySelector("textarea")?.value).toContain("影片风格：水彩");
 await click(editor().querySelector('[data-drama-action="cancel"]'));
 expect(change).toHaveBeenCalledTimes(1);
 await click(button("恢复自动生成"));await click(editor().querySelector('[aria-label="保存视频提示词"]'));
 expect(change.mock.lastCall?.[1].promptOverride).toBeUndefined();
 expect(editor().textContent).toContain("自动生成");
});
it("preserves outdated manual prompts and retains pending input after save failure",async()=>{
 const pending=new Map<string,()=>Promise<void>>();
 let fail=true;
 const {el,change}=await mount({embedded:true,production:{s1:{mode:"first_frame",firstFrame:imageKey,promptOverride:{text:"旧人工提示",sourceFingerprint:"old"}}},onPendingChange:(key,save)=>{if(save)pending.set(key,save);else pending.delete(key);},onWaitForSave:async()=>{if(fail)throw Error("保存冲突");}});
 await click([...el.querySelectorAll("button")].find(b=>b.textContent==="提示词"));
 const editor=()=>el.querySelector('[data-video-prompt-editor]')!;
 expect(editor().textContent).toContain("已保留人工提示词");
 expect(editor().querySelector("pre")?.textContent).toBe("旧人工提示");
 await click(editor().querySelector('[aria-label="编辑视频提示词"]'));
 await click(editor().querySelector('[aria-label="保存视频提示词"]'));
 expect(editor().textContent).toContain("保存冲突");
 expect(editor().querySelector("textarea")?.value).toBe("旧人工提示");
 expect(pending.size).toBe(1);
 fail=false;await act(async()=>{await pending.get("video-prompt:s1")!();});
 expect(change).toHaveBeenCalledTimes(1);
 expect(editor().textContent).not.toContain("已保留人工提示词");
 expect(pending.size).toBe(0);
});

it("embeds one selected shot without a duplicate directory or batch operations",async()=>{
 const {el,action}=await mount({embedded:true,initialShotId:"s3"});
 expect(el.querySelector('[aria-label="视频配置镜头目录"]')).toBeNull();
 expect(el.querySelector('[data-storyboard-video-description]')).toBeNull();
 expect(el.querySelector('[aria-label="批量创建配置"]')).toBeNull();
 expect(mocks.audit).toHaveBeenCalledTimes(1);
 expect(mocks.audit.mock.lastCall?.[0].shot.id).toBe("s3");
 await click([...el.querySelectorAll("button")].find(b=>b.textContent==="创建视频配置"));
 expect(action.mock.lastCall?.[0].shot.id).toBe("s3");
});
it("allows production settings on an unpublished shot but never audits or creates its config",async()=>{
 const {el,action,change}=await mount({embedded:true,confirmedInput:false});
 expect(mocks.audit).not.toHaveBeenCalled();
 expect(el.querySelector('[aria-label="逐镜媒体输入预检"]')).toBeNull();
 const create=[...el.querySelectorAll("button")].find(b=>b.textContent==="创建视频配置")!;
 expect(create.disabled).toBe(true);
 expect(action).not.toHaveBeenCalled();
 await click(el.querySelector('[aria-label="编辑视频输入模式"]'));
 await choose(el.querySelector('select[aria-label="视频输入模式"]'),"omni_reference");
 await click(el.querySelector('[aria-label="确认视频输入模式"]'));
 expect(change.mock.lastCall?.[0]).toBe("s1");
 expect(mocks.audit).not.toHaveBeenCalled();
});
it("mounts batch preparation without any individual audit and audits only selected unconfigured shots",async()=>{
 const el=document.createElement("div");document.body.append(el);
 const root=createRoot(el);roots.push(root);
 const create=vi.fn();
 await act(async()=>root.render(<DramaBatchConfigPanel inputs={inputs} episodes={episodes}
  configs={new Map([["s1",{id:"cfg-1"} as CanvasNodeData]])} missingCount={2} missingFor={()=>[]}
  disabled={false} theme={canvasThemes.dark} onCreateSelected={create}/>));
 expect(mocks.audit).not.toHaveBeenCalled();
 expect(mocks.capabilities).not.toHaveBeenCalled();
 expect(el.querySelector('[aria-label="当前视频配置编辑区"]')).toBeNull();
 expect(el.querySelector('[aria-label="视频配置镜头目录"]')).toBeNull();
 const checks=el.querySelectorAll('input[type="checkbox"]');
 expect(checks).toHaveLength(1);
 await click(checks[0]);
 await choose(el.querySelector('select[aria-label="批量创建配置剧集"]'),"e2");
 await click(el.querySelector('input[type="checkbox"]'));
 await click([...el.querySelectorAll("button")].find(b=>b.textContent?.includes("创建所选视频配置")));
 expect(mocks.audit.mock.calls.map(call=>call[0].shot.id)).toEqual(["s2","s3"]);
 expect(create.mock.lastCall?.[0].map((item:DramaVideoInput)=>item.shot.id)).toEqual(["s2","s3"]);
});
it("stages both frame selections within the editor, commits once, and renders saved thumbnails",async()=>{
 const tail="cas:"+"b".repeat(64);
 const images=[{key:imageKey,title:"首帧候选"},{key:tail,title:"尾帧候选"}];
 const pick=vi.fn();
 const pending=new Map<string,()=>Promise<void>>();
 const persist=vi.fn(async()=>{});
 const {el,change}=await mount({embedded:true,images,onPickImage:pick,onWaitForSave:persist,onPendingChange:(key,save)=>{if(save)pending.set(key,save);else pending.delete(key);}});
 const button=(text:string)=>[...el.querySelectorAll("button")].find(b=>b.textContent?.trim()===text);
 await click(el.querySelector('[aria-label="编辑视频输入模式"]'));
 await choose(el.querySelector('select[aria-label="视频输入模式"]'),"first_last_frame");
 expect(pending.size).toBe(1);
 await click(el.querySelector('[aria-label="选择首帧"]'));
 await click(el.querySelector('[aria-label="选择图片 首帧候选"]'));
 await click(button("使用图片"));
 expect(change).not.toHaveBeenCalled();
 await click(el.querySelector('[aria-label="选择尾帧"]'));
 await click(el.querySelector('[aria-label="选择图片 尾帧候选"]'));
 await click(button("使用图片"));
 expect(change).not.toHaveBeenCalled();expect(pick).not.toHaveBeenCalled();
 expect(el.querySelectorAll('[data-video-mode-field="editing"] img')).toHaveLength(2);
 expect(button("创建视频配置")?.disabled).toBe(true);
 await act(async()=>{await pending.get("video-production:s1")!();});
 expect(change).toHaveBeenCalledTimes(1);
 expect(change.mock.lastCall?.[1]).toMatchObject({mode:"first_last_frame",firstFrame:imageKey,lastFrame:tail});
 expect(persist).toHaveBeenCalledTimes(1);
 expect(el.querySelector('[data-drama-feedback="success"]')?.textContent).toContain("视频输入模式已更新草案");
 expect(pending.size).toBe(0);
 expect(el.querySelectorAll('[data-video-mode-readonly] img')).toHaveLength(2);
 await click(el.querySelector('[aria-label="编辑视频输入模式"]'));
 await click(button("清除尾帧"));expect(pending.size).toBe(1);
 await click(el.querySelector('[data-drama-action="cancel"]'));
 expect(change).toHaveBeenCalledTimes(1);expect(pending.size).toBe(0);
 expect(el.querySelectorAll('[data-video-mode-readonly] img')).toHaveLength(2);
});
it("supports grid selection and discards the draft without writing on cancellation",async()=>{
 const {el,change}=await mount({embedded:true,images:[{key:imageKey,title:"网格候选"}]});
 await click(el.querySelector('[aria-label="编辑视频输入模式"]'));
 await choose(el.querySelector('select[aria-label="视频输入模式"]'),"grid");
 await click(el.querySelector('[aria-label="选择分镜网格图"]'));
 await click(el.querySelector('[aria-label="选择图片 网格候选"]'));
 await click([...el.querySelectorAll("button")].find(b=>b.textContent==="使用图片"));
 expect(change).not.toHaveBeenCalled();
 await click(el.querySelector('[data-drama-action="cancel"]'));
 expect(change).not.toHaveBeenCalled();
 expect(el.querySelector('[data-video-mode-readonly]')?.textContent).toContain("纯文本");
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
