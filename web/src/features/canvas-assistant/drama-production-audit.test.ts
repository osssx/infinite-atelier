// @vitest-environment happy-dom
import {describe,it,expect,vi} from "vitest";
import {defaultConfig,type AiConfig} from "@/stores/use-config-store";
import {applyDramaProduction,type DramaVideoInput} from "./drama-pipeline-media";
import {auditDramaProduction,listDramaProductionCapabilities} from "./drama-production-audit";
import {prepareDramaProduction} from "./drama-media-preflight";
import {resolveDramaVideoProduction} from "./drama-video-production-resolver";
import {planDramaBatchVideoConfigs,refreshDramaVideoConfig} from "./drama-video-config";
import {resolveComfyWorkflowSelection} from "@/features/comfy-workflow/comfy-workflow-selection";
import {createCanvasNode} from "@/lib/canvas/canvas-node-factory";
import type {DramaShotProduction} from "./drama-pipeline-media";

vi.mock("@/features/comfy-workflow/template-registry",()=>({
    getComfyTemplate:async(id:string)=>({
        name:"Local tested video",
        ports:[
            {id:"prompt",direction:"target",valueKind:"STRING"},
            {id:"reference",direction:"target",valueKind:id==="bad-port"?"STRING":"IMAGE"},
            {id:"first",direction:"target",valueKind:"IMAGE"},
            {id:"last",direction:"target",valueKind:"IMAGE"},
            {id:"duration",direction:"target",valueKind:"FLOAT",defaultValue:5},
        ],
        mediaUseCase:{
            channel:"video",modeBindings:{
                text_to_video:{promptPortId:"prompt"},
                first_frame:{promptPortId:"prompt",rolePorts:{first_frame:["first"]}},
                first_last_frame:{promptPortId:"prompt",rolePorts:{first_frame:["first"],last_frame:["last"]}},
                omni_reference:{promptPortId:"prompt",rolePorts:{reference_image:["reference"]}},
            },
            mediaCapabilities:{schemaVersion:1,kind:"video",modes:[
                {id:"text_to_video",enabled:true,inputs:[],parameters:[]},
                {id:"first_frame",enabled:true,inputs:[{role:"first_frame",kind:"image",minItems:1,maxItems:1}],parameters:[]},
                {id:"first_last_frame",enabled:true,inputs:[
                    {role:"first_frame",kind:"image",minItems:1,maxItems:1},
                    {role:"last_frame",kind:"image",minItems:1,maxItems:1},
                ],parameters:[]},
                {id:"omni_reference",enabled:true,inputs:[{role:"reference_image",kind:"image",minItems:1,maxItems:1}],
                    maxTotalReferences:1,parameters:[]},
            ]},
        },
    }),
}));
const key=(char:string)=>"cas:"+char.repeat(64);
const base:DramaVideoInput={shot:{
    id:"shot",episodeId:"ep",order:3,description:"Opening",durationSec:5,
    characterVariantIds:["hero-day"],propIds:["star"],keyPropIds:["star"],
},prompt:"Opening",referenceImages:[],mode:"text_to_video"};
const online:AiConfig={...defaultConfig,videoModel:"audit::model",videoRatio:"9:16",
    videoSeconds:"6",comfyWorkflowDefaults:{},channels:[{id:"audit",name:"API only",baseUrl:"https://api.openai.com/v1",
        apiKey:"",apiFormat:"openai",models:[{name:"model",capability:"video"}]}]};
const comfy=(id="template"):AiConfig=>({...online,comfyWorkflowDefaults:{video:{templateId:id,templateRevision:"rev"}}});

describe("P3.1 explicit production mode / media audit",()=>{
    it("pins online choice over global Comfy, persists exact manual prompt and production parameters without touching the confirmed shot",async()=>{
        const global=comfy();
        const setting:DramaShotProduction={mode:"text_to_video",target:{kind:"online",modelOption:"audit::model"},
          promptOverride:{text:"人工提示词，保持风格",sourceFingerprint:"old"},durationSec:8,aspectRatio:"9:16"};
        const effective=resolveDramaVideoProduction(base,global,setting,"Ink","board-v1");
        expect(effective.promptOutdated).toBe(true);
        expect(global.comfyWorkflowDefaults?.video?.templateId).toBe("template");
        const audit=await auditDramaProduction(base,global,{setting,visualStyle:"Ink",sourceRevisionId:"board-v1"});
        expect(audit.ready).toBe(true);
        expect(audit.engine).toBe("online");
        expect(audit.input?.comfyBinding).toBeUndefined();
        expect(audit.prompt).toBe(setting.promptOverride!.text);
        expect(audit.input?.shot).toEqual(base.shot);
        expect(audit.input?.productionSnapshot).toMatchObject({target:setting.target,prompt:audit.prompt,durationSec:8,aspectRatio:"9:16",manualPrompt:true});
        const source=createCanvasNode("drama:storyboard",{x:0,y:0},{dramaConfirmedVersionId:"board-v1",dramaShotProduction:{shot:setting}});
        const {graph,result}=planDramaBatchVideoConfigs(source,[base.shot],[audit.input!],[source],[],"Other","16:9");
        expect(result.createdShotIds).toEqual(["shot"]);
        const node=graph.nodes.find(item=>graph.configIds.includes(item.id))!;
        expect(node.metadata).toMatchObject({model:"audit::model",prompt:audit.prompt,composerContent:audit.prompt,seconds:"8",videoRatio:"9:16"});
        expect(resolveComfyWorkflowSelection(global,node,"video")).toBeUndefined();
        expect(()=>refreshDramaVideoConfig(node,base,{prompt:true,duration:false,overwrite:false})).toThrow("人工修改");
        const changed={...source,metadata:{...source.metadata,dramaShotProduction:{shot:{...setting,durationSec:9}}}};
        expect(planDramaBatchVideoConfigs(changed,[base.shot],[audit.input!],[changed],[]).result.failures[0].error).toContain("重新预检");
        expect(planDramaBatchVideoConfigs({...source,metadata:{...source.metadata,dramaConfirmedVersionId:"board-v2"}},[base.shot],[audit.input!],[source],[]).result.failures).toHaveLength(1);
    });
    it("uses independent explicit workflow per shot and rejects removed model rather than inheriting Comfy",async()=>{
        const setting:DramaShotProduction={mode:"first_frame",firstFrame:key("a"),target:{kind:"comfy",templateId:"chosen",templateRevision:"pinned"}};
        const input=applyDramaProduction(base,setting);
        const result=await auditDramaProduction(input,online,{setting});
        expect(result.ready).toBe(true);
        expect(result.input?.comfyBinding).toMatchObject({templateId:"chosen",templateRevision:"pinned"});
        const missing:DramaShotProduction={mode:"text_to_video",target:{kind:"online",modelOption:"removed::model"}};
        expect((await auditDramaProduction(base,comfy(),{setting:missing})).ready).toBe(false);
        expect((await listDramaProductionCapabilities(comfy(),missing)).modes.every(item=>!item.available)).toBe(true);
        const invalid:DramaShotProduction={mode:"text_to_video",promptOverride:{text:"@[node:bad]",sourceFingerprint:"old"}};
        expect((await auditDramaProduction(base,online,{setting:invalid})).error).toContain("内部节点引用");
    });
    it("filters unsupported API input modes before Config creation and shows precise failure",async()=>{
        const result=await listDramaProductionCapabilities(online);
        expect(result.engine).toBe("online");
        expect(result.modes.filter(mode=>mode.available).map(mode=>mode.mode)).toEqual(["text_to_video"]);
        const input=applyDramaProduction(base,{mode:"first_frame",firstFrame:key("a")});
        const audit=await auditDramaProduction(input,online,{setting:{mode:"first_frame"}});
        expect(audit.ready).toBe(false);
        expect(audit.error).toContain("不支持");
        expect(audit.referenceCount).toBe(1);
        expect(audit.referenceKeys).toEqual([key("a")]);
        expect(audit.durationSeconds).toBe(5);
        expect(audit.aspectRatio).toBe("9:16");
        expect(audit.sourceRevisionId).toBeUndefined();
        expect((await auditDramaProduction(base,online,{sourceRevisionId:"confirmed-1"})).ready).toBe(true);
    });
    it("preflights first and last CAS frames against Comfy role ports and preserves source revision",async()=>{
        const setting={mode:"first_last_frame" as const,firstFrame:key("a"),lastFrame:key("b")};
        const input=applyDramaProduction(base,setting);
        const capabilities=await listDramaProductionCapabilities(comfy());
        expect(capabilities.modes.map(item=>item.available)).toEqual([true,true,true,true,true]);
        const audit=await auditDramaProduction(input,comfy(),{
            setting,sourceRevisionId:"board-v9",visualStyle:"Ink",
        });
        expect(audit.ready).toBe(true);
        expect(audit.engine).toBe("comfy");
        expect(audit.input?.comfyBinding?.mediaMode).toBe("first_last_frame");
        expect(audit.input?.comfyBinding?.slots).toEqual({
            first:{nodeId:"shot-frame-0"},last:{nodeId:"shot-frame-1"},
        });
        expect(audit.prompt).toContain("影片风格：Ink");
        expect(audit.sourceRevisionId).toBe("board-v9");
    });
    it("grid is an explicit single CAS input, only accepted through mapped Comfy reference slot",async()=>{
        const setting={mode:"omni_reference" as const,gridInput:true,gridImage:key("c")};
        const input=applyDramaProduction(base,setting);
        expect(input.gridInput).toBe(true);
        const api=await auditDramaProduction(input,online,{setting});
        expect(api.ready).toBe(false);
        expect(api.error).toContain("ComfyUI");
        const result=await auditDramaProduction(input,comfy(),{setting});
        expect(result.ready).toBe(true);
        expect(result.input?.comfyBinding?.slots).toEqual({reference:{nodeId:"shot-grid"}});
        expect(result.input?.referenceImages.map(ref=>ref.storageKey)).toEqual([key("c")]);
        expect(result.input?.prompt).toContain("从左到右");
        await expect(prepareDramaProduction(input,comfy("bad-port"))).rejects.toThrow("端口绑定");
    });
    it("rejects incomplete asset references and does not silently wire excess images",async()=>{
        const input=applyDramaProduction(base,{mode:"omni_reference"});
        const audit=await auditDramaProduction({...input,referenceImages:[{
            id:"actor",name:"Actor",dataUrl:"",type:"image/png",storageKey:key("d"),
        }]},comfy(),{setting:{mode:"omni_reference"},missingReferenceIds:["star"]});
        expect(audit.ready).toBe(false);
        expect(audit.error).toContain("star");
        const two={...input,referenceImages:["d","e"].map((letter,index)=>({
            id:"ref-"+index,name:"Image",dataUrl:"",type:"image/png",storageKey:key(letter),
        }))};
        await expect(prepareDramaProduction(two,comfy())).rejects.toThrow("media_");
        const invalid={...input,referenceImages:[{id:"no-cas",name:"Unsaved",
            dataUrl:"data:image/png;base64,AA==",type:"image/png"}]};
        await expect(prepareDramaProduction(invalid,comfy())).rejects.toThrow("CAS");
    });
});
