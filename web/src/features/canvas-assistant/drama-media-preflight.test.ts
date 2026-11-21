// @vitest-environment happy-dom
import {describe,it,expect,vi} from "vitest";
import {defaultConfig,type AiConfig} from "@/stores/use-config-store";
import {preflightDramaVideo,prepareDramaProduction} from "./drama-media-preflight";
vi.mock("@/features/comfy-workflow/template-registry",()=>({getComfyTemplate:async()=>({
    ports:[{id:"duration",direction:"target",defaultValue:5},{id:"frame",direction:"target",valueKind:"IMAGE"}],mediaUseCase:{channel:"video",modeBindings:{first_frame:{
        rolePorts:{first_frame:["frame"]},parameterPorts:{duration_seconds:"duration"},
    }},mediaCapabilities:{schemaVersion:1,kind:"video",modes:[{id:"first_frame",enabled:true,
        inputs:[{role:"first_frame",kind:"image",minItems:1,maxItems:1}],parameters:[{
            id:"duration_seconds",type:"number",mode:"adjustable",min:1,max:10,
        }]}]}},
})}));
import type {DramaVideoInput} from "./drama-pipeline-media";

describe("drama production preflight",()=>{
    const config:AiConfig={...defaultConfig,videoModel:"test::video",channels:[{
        id:"test",name:"Test",baseUrl:"https://api.openai.com/v1",apiKey:"",apiFormat:"openai",
        models:[{name:"video",capability:"video"}],
    }]};
    const input:DramaVideoInput={shot:{id:"shot",episodeId:"ep",order:1,description:"Opening",
        characterVariantIds:[],propIds:[],keyPropIds:[]},prompt:"Opening",referenceImages:[],mode:"text_to_video"};
    it("allows supported text input and refuses frame inputs for a text-only executor",()=>{
        expect(()=>preflightDramaVideo(input,config)).not.toThrow();
        expect(()=>preflightDramaVideo({...input,mode:"first_frame"},config)).toThrow("不支持");
    });
    it("binds an explicit frame and duration to the default Comfy template",async()=>{
        const comfy={...config,comfyWorkflowDefaults:{video:{templateId:"template",templateRevision:"revision"}}};
        const prepared=await prepareDramaProduction({...input,mode:"first_frame",shot:{...input.shot,durationSec:7},
            referenceImages:[{id:"reference",name:"Frame",type:"image/png",dataUrl:"",storageKey:"cas:"+"a".repeat(64)}]},comfy);
        expect(prepared.comfyBinding?.overrides).toEqual({duration:7});
        expect(prepared.comfyBinding?.slots).toEqual({frame:{nodeId:"reference"}});
        await expect(prepareDramaProduction({...input,mode:"first_last_frame"},comfy)).rejects.toThrow("未声明");
    });
    it("enforces the declared model input and duration constraints",()=>{
        const declared:AiConfig={...config,channels:[{...config.channels[0],models:[{
            name:"video",capability:"video",mediaCapabilities:{schemaVersion:1,kind:"video",modes:[{
                id:"text_to_video",enabled:true,inputs:[],parameters:[{
                    id:"duration_seconds",mode:"adjustable",type:"number",min:1,max:8,
                }],
            }]},
        }]}]};
        expect(()=>preflightDramaVideo({...input,shot:{...input.shot,durationSec:12}},declared)).toThrow("预检失败");
    });
});
