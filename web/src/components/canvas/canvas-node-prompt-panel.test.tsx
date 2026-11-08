import {createElement,type ButtonHTMLAttributes,type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";

vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key,i18n:{resolvedLanguage:"zh-CN"}}),initReactI18next:{type:"3rdParty",init:()=>{}}}));
vi.mock("@/i18n",()=>({default:{t:(key:string)=>key,resolvedLanguage:"zh-CN"}}));
vi.mock("antd",()=>({
 Button:({children,danger:_danger,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{danger?:boolean})=>
  createElement("button",props,children),Tooltip:({children}:{children:ReactNode})=>children,Modal:()=>null
}));
vi.mock("lucide-react",()=>Object.fromEntries(["ArrowUp","LoaderCircle","Maximize2","Square","BookOpen"]
 .map(name=>[name,()=>createElement("i",{"data-icon":name})])));
vi.mock("@/components/model-picker",()=>({ModelPicker:()=>null}));
vi.mock("./canvas-image-settings-popover",()=>({CanvasImageSettingsPopover:()=>null}));
vi.mock("./canvas-audio-settings-popover",()=>({CanvasAudioSettingsPopover:()=>null}));
vi.mock("./canvas-video-settings-popover",()=>({CanvasVideoSettingsPopover:()=>null}));
vi.mock("./canvas-text-settings-popover",()=>({CanvasTextSettingsPopover:()=>null}));
vi.mock("./canvas-prompt-library",()=>({CanvasPromptLibrary:()=>null}));
vi.mock("./canvas-prompt-chip-input",()=>({CanvasPromptChipInput:({value}:{value:string})=>createElement("textarea",{value,readOnly:true})}));
vi.mock("./canvas-graph-context",()=>({useNodeMentionReferences:()=>[]}));
vi.mock("@/stores/use-config-store",()=>({
 defaultConfig:{model:"image-model",quality:"auto",size:"auto",reasoningEffort:"low",background:"auto",
  videoSeconds:"6",videoMode:"text_to_video",videoRatio:"16:9",videoReturnLastFrame:false,vquality:"720p",
  videoGenerateAudio:true,videoWatermark:false,audioVoice:"alloy",audioFormat:"mp3",audioSpeed:1,audioInstructions:"",count:"1"},
 resolveModelForCapability:(config:unknown)=>config,useEffectiveConfig:()=>({model:"image-model"}),
 useConfigStore:(selector:(value:{openConfigDialog:(open:boolean)=>void})=>unknown)=>selector({openConfigDialog:()=>{}})
}));
vi.mock("@/stores/use-theme-store",()=>({useThemeStore:(selector:(value:{theme:string})=>unknown)=>selector({theme:"dark"})}));

import {CanvasNodePromptPanel} from "./canvas-node-prompt-panel";
import {cancelCanvasNodeExecution,finishCanvasTextJob,finishCanvasTextSubmission,
 beginCanvasTextSubmission,setCanvasTextExecutionScope,trackCanvasTextJob} from "@/features/backend-sync/canvas-text-execution-visual";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";

const image:CanvasNodeData={id:"image-source",type:CanvasNodeType.Image,title:"Image",
 position:{x:0,y:0},width:420,height:420,metadata:{composerContent:"draw a red fox"}};
const render=(onStop=vi.fn())=>renderToStaticMarkup(createElement(CanvasNodePromptPanel,{
 node:image,isRunning:false,onPromptChange:vi.fn(),onConfigChange:vi.fn(),onGenerate:vi.fn(),onStop
}));

describe("image prompt panel execution action",()=>{
 beforeEach(()=>setCanvasTextExecutionScope("project"));
 afterEach(()=>setCanvasTextExecutionScope(null));

 it("switches send to stop for active runs, disables while stopping, and restores send at completion",async()=>{
  expect(render()).toContain('aria-label="canvas.promptPanel.generate"');
  beginCanvasTextSubmission("project",image.id,"submitting","image");
  expect(render()).toContain('aria-label="canvas.promptPanel.stopGeneration"');
  trackCanvasTextJob("project",image.id,"job","queued","submitting","image");
  finishCanvasTextSubmission("project",image.id,"submitting");
  expect(render()).toContain("canvas.promptPanel.stop");

  let resolveCancel:(result:{cancelled:boolean;reason?:string})=>void=()=>{};
  const cancelling=cancelCanvasNodeExecution("project",image.id,
   ()=>new Promise(resolve=>{resolveCancel=resolve}),vi.fn());
  await Promise.resolve();
  expect(render()).toContain("disabled=");
  resolveCancel({cancelled:false,reason:"not_queued"});
  await cancelling;
  finishCanvasTextJob("project","job");
  expect(render()).toContain('aria-label="canvas.promptPanel.generate"');

  trackCanvasTextJob("project",image.id,"restored-job","running",undefined,"image");
  expect(render()).toContain('aria-label="canvas.promptPanel.stopGeneration"');
  setCanvasTextExecutionScope("other-project");
  expect(render()).toContain('aria-label="canvas.promptPanel.generate"');
 });

 it("keeps Stop visible until every concurrent media request finishes",()=>{
  trackCanvasTextJob("project",image.id,"image-job-1","queued",undefined,"image");
  trackCanvasTextJob("project",image.id,"image-job-2","running",undefined,"image");
  expect(render()).toContain('aria-label="canvas.promptPanel.stopGeneration"');
  finishCanvasTextJob("project","image-job-1");
  expect(render()).toContain('aria-label="canvas.promptPanel.stopGeneration"');
  finishCanvasTextJob("project","image-job-2");
  expect(render()).toContain('aria-label="canvas.promptPanel.generate"');
 });
});
