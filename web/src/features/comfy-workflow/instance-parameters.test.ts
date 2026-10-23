import { describe, expect, it } from "vitest";
import { createComfyTemplate } from "./template-schema";
import { krea2TurboBundledTemplate, KREA2_TURBO_TEMPLATE_ID } from "./krea2-turbo-preset";
import {
    generateComfySafeSeed, getComfyInstanceScalarFields,
    parseComfyScalarOverride, setComfyInstanceOverride, removeComfyInstanceOverride,
} from "./instance-parameters";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

const mockNode = (id:string, overrides:Record<string,unknown>={}):CanvasNodeData=>({
    id,type:"comfy:workflow",title:id,position:{x:0,y:0},width:360,height:265,
    metadata:{comfyWorkflow:{templateId:KREA2_TURBO_TEMPLATE_ID,
        templateRevision:"test",bindingState:"needs-instance-binding",inputOverrides:overrides}},
});

describe("ComfyUI workflow instance-level scalar parameters",()=>{
    it("discovers 11 editable scalar controls from the real Krea2 template without rewriting graph",async()=>{
        const template=await createComfyTemplate(KREA2_TURBO_TEMPLATE_ID,krea2TurboBundledTemplate());
        const fields=getComfyInstanceScalarFields(template,mockNode("krea"),[]);
        expect(fields).toHaveLength(11);
        expect(fields.find((f)=>f.port.id==="width")?.localValue).toEqual({source:"template",value:1024});
        expect(fields.find((f)=>f.port.id==="steps")?.localValue).toEqual({source:"template",value:8});
        expect(fields.find((f)=>f.port.id==="refine_prompt")?.localValue).toEqual({source:"template",value:true});
        expect(fields.find((f)=>f.port.id==="enable_lora")?.localValue).toEqual({source:"template",value:false});
        expect(fields.find((f)=>f.port.id==="seed")?.localValue).toEqual({source:"template",value:890136353298824});
        expect(template.apiGraph["30:3"].inputs.steps).toBe(8);
    });
    it("preserves per-node overrides and edge > override priority, then restores overrides after disconnect",async()=>{
        const template=await createComfyTemplate(KREA2_TURBO_TEMPLATE_ID,krea2TurboBundledTemplate());
        const original=mockNode("a",{width:768,refine_prompt:false});
        const unrelated=mockNode("b",{width:2048});
        const wire:CanvasConnection={id:"edge-1",fromNodeId:"upstream",fromPortId:"value",toNodeId:"a",toPortId:"width"};
        const linked=getComfyInstanceScalarFields(template,original,[wire]).find((f)=>f.port.id==="width")!;
        expect(linked.source).toBe("edge");
        expect(linked.connectedFrom).toEqual({nodeId:"upstream",portId:"value"});
        expect(linked.localValue).toEqual({source:"override",value:768});
        const after=getComfyInstanceScalarFields(template,original,[]).find((f)=>f.port.id==="width")!;
        expect(after.source).toBe("override");
        expect(after.localValue).toEqual({source:"override",value:768});
        expect(getComfyInstanceScalarFields(template,original,[]).find((f)=>f.port.id==="refine_prompt")?.localValue)
            .toEqual({source:"override",value:false});
        expect(getComfyInstanceScalarFields(template,unrelated,[]).find((f)=>f.port.id==="width")?.localValue).toEqual({source:"override",value:2048});
        expect(template.apiGraph["30:5"].inputs.width).toBe(1024);
    });
    it("resolves override > port default > original Comfy graph, including 0/false/empty string",async()=>{
        const draft=krea2TurboBundledTemplate();
        const width=draft.ports.find((p)=>p.id==="width")!;
        width.defaultValue=512;
        const template=await createComfyTemplate(KREA2_TURBO_TEMPLATE_ID,draft);
        const base=getComfyInstanceScalarFields(template,mockNode("a"),[]);
        expect(base.find((f)=>f.port.id==="width")?.localValue).toEqual({source:"default",value:512});
        const overridden=getComfyInstanceScalarFields(template,mockNode("a",{width:0,refine_prompt:false,prompt:""}),[]);
        expect(overridden.find((f)=>f.port.id==="width")?.localValue).toEqual({source:"override",value:0});
        expect(overridden.find((f)=>f.port.id==="refine_prompt")?.localValue).toEqual({source:"override",value:false});
        expect(overridden.find((f)=>f.port.id==="prompt")?.localValue).toEqual({source:"override",value:""});
        const reset=removeComfyInstanceOverride({width:0,refine_prompt:false},"width");
        expect(reset).toEqual({refine_prompt:false});
        expect(setComfyInstanceOverride(reset,"width",256)).toEqual({refine_prompt:false,width:256});
    });
    it("rejects invalid number values, unsafe integer precision, NaN/infinity and excess text",()=>{
        expect(parseComfyScalarOverride("INT","9007199254740991")).toEqual({ok:true,value:Number.MAX_SAFE_INTEGER});
        expect(parseComfyScalarOverride("INT","890136353298824")).toEqual({ok:true,value:890136353298824});
        expect(parseComfyScalarOverride("INT","1.5").ok).toBe(false);
        expect(parseComfyScalarOverride("INT","9007199254740992").ok).toBe(false);
        expect(parseComfyScalarOverride("INT","").ok).toBe(false);
        expect(parseComfyScalarOverride("FLOAT","-1.25e-3")).toEqual({ok:true,value:-0.00125});
        expect(parseComfyScalarOverride("FLOAT","Infinity").ok).toBe(false);
        expect(parseComfyScalarOverride("FLOAT","NaN").ok).toBe(false);
        expect(parseComfyScalarOverride("FLOAT","1e309").ok).toBe(false);
        expect(parseComfyScalarOverride("STRING","")).toEqual({ok:true,value:""});
        expect(parseComfyScalarOverride("STRING","a".repeat(16001)).ok).toBe(false);
        expect(parseComfyScalarOverride("BOOLEAN",false)).toEqual({ok:true,value:false});
        expect(parseComfyScalarOverride("BOOLEAN",true)).toEqual({ok:true,value:true});
    });
    it("creates a seed within the safe integer range rather than losing precision",()=>{
        for(let i=0;i<16;i++) {
            const seed=generateComfySafeSeed();
            expect(Number.isSafeInteger(seed)).toBe(true);
            expect(seed).toBeGreaterThanOrEqual(0);
        }
    });
});
