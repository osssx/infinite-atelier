import { describe, expect, it } from "vitest";
import sourceWorkflow from "../../../../workflows/image_krea2_turbo_t2i_int8.json";
import {
    buildKrea2TurboTemplate,
    isKrea2TurboT2IWorkflow,
    krea2TurboBundledTemplate,
    KREA2_TURBO_TEMPLATE_ID,
} from "./krea2-turbo-preset";
import { createComfyTemplate, validateComfyApiGraph, validateComfyTemplatePayload } from "./template-schema";

describe("Krea 2 Turbo INT8 API workflow bindings", () => {
    it("recognizes the real 25-node source graph without modifying internal links or model paths", () => {
        const raw = validateComfyApiGraph(sourceWorkflow);
        expect(Object.keys(raw).length).toBe(25);
        expect(isKrea2TurboT2IWorkflow(raw)).toBe(true);
        const configured = krea2TurboBundledTemplate();
        expect(configured.apiGraph).toEqual(raw);
        expect(configured.requirements.modelAssets).toEqual([
            "krea2\\KNP_000003000.safetensors",
            "krea2\\krea2filterbypass3.safetensors",
            "krea2_turbo_int8_convrot.safetensors",
            "qwen3vl_4b_fp8_scaled.safetensors",
            "qwen_image_vae.safetensors",
        ]);
        expect(configured.requirements.classTypes).toContain("TextGenerate");
    });
    it("exposes prompt and actual sampler/latent controls, not disconnected ResolutionSelector(49)", () => {
        const {ports,apiGraph} = krea2TurboBundledTemplate();
        const targets = new Map(ports.filter((p)=>p.direction==="target")
            .map((p)=>[p.id,p.inputBinding?.targets[0]]));
        expect(targets.size).toBe(11);
        expect(targets.get("prompt")).toEqual({nodeId:"55",inputName:"value"});
        expect(targets.get("width")).toEqual({nodeId:"30:5",inputName:"width"});
        expect(targets.get("height")).toEqual({nodeId:"30:5",inputName:"height"});
        expect(targets.get("seed")).toEqual({nodeId:"30:3",inputName:"seed"});
        expect(targets.get("steps")).toEqual({nodeId:"30:3",inputName:"steps"});
        expect(targets.get("cfg")).toEqual({nodeId:"30:3",inputName:"cfg"});
        expect(targets.get("refine_prompt")).toEqual({nodeId:"30:24",inputName:"value"});
        expect(targets.get("enable_lora")).toEqual({nodeId:"30:23",inputName:"value"});
        expect(targets.get("lora_strength")).toEqual({nodeId:"30:15",inputName:"strength_model"});
        expect(targets.get("refine_temperature")).toEqual({nodeId:"30:16",inputName:"sampling_mode.temperature"});
        expect([...targets.values()].some((target)=>target?.nodeId==="49")).toBe(false);
        expect(apiGraph["49"].inputs.aspect_ratio).toBe("1:1 (Square)");
        expect(apiGraph["30:5"].inputs.width).toBe(1024);
        expect(apiGraph["30:5"].inputs.height).toBe(1024);
    });
    it("binds the IMAGE socket consumed by SaveImage to a capturable output", async () => {
        const configured = krea2TurboBundledTemplate();
        const output = configured.ports.find((p)=>p.id==="image")!;
        expect(output).toMatchObject({
            direction:"source",valueKind:"IMAGE",
            outputBinding:{nodeId:"30:8",outputIndex:0},
            capture:{kind:"image",adapterId:"SaveImage"},
        });
        expect(configured.apiGraph["29"].inputs.images).toEqual(["30:8",0]);
        expect(validateComfyTemplatePayload(configured).ports).toHaveLength(12);
        const saved=await createComfyTemplate(KREA2_TURBO_TEMPLATE_ID,configured);
        expect(saved.revision).toMatch(/^[0-9a-f]{64}$/);
    });
    it("prevents accidentally applying this fixed binding map to a different workflow", () => {
        const broken=structuredClone(sourceWorkflow);
        broken["30:10"].inputs.unet_name="other-model.safetensors";
        expect(isKrea2TurboT2IWorkflow(validateComfyApiGraph(broken))).toBe(false);
        expect(()=>buildKrea2TurboTemplate(broken)).toThrow(/not the supported Krea 2 Turbo/);
    });
});
