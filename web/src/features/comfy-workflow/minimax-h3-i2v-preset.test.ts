import { describe, expect, it } from "vitest";
import source from "../../../../workflows/video_minimax_h3_i2v_turbo.json";
import { buildMiniMaxH3I2VPreset, isMiniMaxH3I2VWorkflow, minimaxH3I2VBundledTemplate,
    MINIMAX_H3_I2V_TEMPLATE_ID } from "./minimax-h3-i2v-preset";
import { createComfyTemplate, validateComfyApiGraph, validateComfyTemplatePayload } from "./template-schema";

describe("MiniMax H3 I2V Turbo bundled API workflow",()=>{
    it("recognizes the real source without changing model paths or internal links",()=>{
        const graph=validateComfyApiGraph(source);
        expect(Object.keys(graph)).toHaveLength(27);
        expect(isMiniMaxH3I2VWorkflow(graph)).toBe(true);
        const configured=minimaxH3I2VBundledTemplate();
        expect(configured.apiGraph).toEqual(graph);
        expect(configured.requirements.classTypes).toContain("MiniMaxH3ImageToVideo");
        expect(configured.requirements.modelAssets).toContain("minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors");
        expect(configured.requirements.modelAssets).toContain("minimax_h3_video_vae_int8_convrot_v2.safetensors");
    });
    it("exposes first-frame IMAGE filename, prompt, duration, aspect ratio and video capture",async()=>{
        const preset=minimaxH3I2VBundledTemplate();
        const ports=new Map(preset.ports.map(port=>[port.id,port]));
        expect(ports.get("first_frame")).toMatchObject({
            required:false,direction:"target",valueKind:"IMAGE",absentPolicy:{mode:"auto-prune"},
            inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"114",inputName:"image"}]},
        });
        expect(ports.get("prompt")).toMatchObject({required:true,inputBinding:{targets:[{nodeId:"105_104",inputName:"prompt"}]}});
        expect(ports.get("duration")?.inputBinding?.targets).toEqual([{nodeId:"128",inputName:"value"}]);
        expect(ports.get("aspect_ratio")?.inputBinding?.targets).toEqual([{nodeId:"115",inputName:"aspect_ratio"}]);
        expect(ports.get("video")).toMatchObject({
            direction:"source",valueKind:"VIDEO",
            outputBinding:{nodeId:"105_91",outputIndex:0},
            capture:{kind:"video",adapterId:"SaveVideo"},
        });
        expect(preset.ports.some(port=>port.direction==="source"&&port.valueKind==="IMAGE")).toBe(false);
        expect(validateComfyTemplatePayload(preset).ports).toHaveLength(12);
        expect((await createComfyTemplate(MINIMAX_H3_I2V_TEMPLATE_ID,preset)).revision).toMatch(/^[0-9a-f]{64}$/);
    });
    it("does not apply this fixed binding map to an unrelated workflow",()=>{
        const invalid=structuredClone(source);
        invalid["105_104"].class_type="OtherVideoNode";
        expect(isMiniMaxH3I2VWorkflow(validateComfyApiGraph(invalid))).toBe(false);
        expect(()=>buildMiniMaxH3I2VPreset(invalid)).toThrow(/not the supported MiniMax/);
    });
});
