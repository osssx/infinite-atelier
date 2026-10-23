import { describe, expect, it } from "vitest";
import {
    canonicalComfyJson, comfySha256, createComfyTemplate, templatePayloadFromGraph,
    validateComfyApiGraph, validateComfyTemplatePayload, verifyComfyTemplate,
    type ComfyObjectInfo, type ComfyTemplatePayload,
} from "./template-schema";

const graph = () => ({
    "10": { class_type:"Prompt",inputs:{text:"hello"} },
    "20": { class_type:"Images",inputs:{prompt:["10",0],strength:0.3,image:"sample.png"} },
    "30": { class_type:"SaveImage",inputs:{images:["20",0]} },
});
const info: ComfyObjectInfo = {
    Prompt:{input:{required:{text:["STRING",{}]}},output:["STRING"]},
    Images:{input:{required:{prompt:["STRING",{}],strength:["FLOAT",{}],image:["STRING",{}]}},output:["IMAGE"]},
    SaveImage:{input:{required:{images:["IMAGE",{}]}},output:[]},
};
const payload = (): ComfyTemplatePayload => ({
    ...templatePayloadFromGraph("Example",graph(),info),
    ports: [
        {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",inputBinding:{mode:"literal",targets:[{nodeId:"10",inputName:"text"}]}},
        {id:"strength",label:"Strength",direction:"target",valueKind:"FLOAT",inputBinding:{mode:"literal",targets:[{nodeId:"20",inputName:"strength"}]},defaultValue:0},
        {id:"image",label:"Image",direction:"target",valueKind:"IMAGE",inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"20",inputName:"image"}]}},
        {id:"output",label:"Output",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"20",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}},
    ],
});
describe("Phase B: ComfyUI API graph and immutable bindings", () => {
    it("imports Save(API Format), checks required classes/inputs and output slot", () => {
        expect(validateComfyApiGraph(graph(),info)["20"].class_type).toBe("Images");
        expect(validateComfyTemplatePayload(payload(),info).ports).toHaveLength(4);
        expect(() => validateComfyApiGraph({nodes:[],links:[]},info)).toThrow(/API Format/);
        expect(() => validateComfyApiGraph({...graph(),"11":{class_type:"NotInstalled",inputs:{}}},info)).toThrow(/missing ComfyUI class/);
        const dangling = graph(); dangling["20"].inputs.prompt=["99",0];
        expect(() => validateComfyApiGraph(dangling)).toThrow(/dangling link/);
        const invalidSlot = graph(); invalidSlot["20"].inputs.prompt=["10",1];
        expect(() => validateComfyApiGraph(invalidSlot,info)).toThrow(/out of range/);
        const cycle = graph(); (cycle["10"].inputs as Record<string,unknown>).text=["20",0];
        expect(() => validateComfyApiGraph(cycle)).toThrow(/cycle/);
    });
    it("requires distinct input claims and valid mapping target types", () => {
        const duplicate = payload();
        duplicate.ports.push({id:"other",label:"Other",direction:"target",valueKind:"STRING",
            inputBinding:{mode:"literal",targets:[{nodeId:"10",inputName:"text"}]}});
        expect(() => validateComfyTemplatePayload(duplicate)).toThrow(/duplicate input claim/);
        const missing = payload();
        missing.ports[0].inputBinding!.targets[0].nodeId="404";
        expect(() => validateComfyTemplatePayload(missing)).toThrow(/target missing/);
        const wrongKind=payload();wrongKind.ports[0].valueKind="IMAGE";
        expect(() => validateComfyTemplatePayload(wrongKind,info)).toThrow(/literal mode supports only scalar/);
    });
    it("requires an explicit socket replacement policy, and never writes socket tuples into file inputs", () => {
        const invalid = payload();
        invalid.ports[0].inputBinding={mode:"socket",replaceInternalLink:false,targets:[{nodeId:"20",inputName:"prompt"}]};
        expect(() => validateComfyTemplatePayload(invalid)).toThrow(/overwrites internal link/);
        invalid.ports[0].inputBinding.replaceInternalLink=true;
        expect(validateComfyTemplatePayload(invalid,info).ports[0].inputBinding?.mode).toBe("socket");
        const file=payload();
        file.ports[2].inputBinding={mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"20",inputName:"prompt"}]};
        expect(() => validateComfyTemplatePayload(file)).toThrow(/file sink is connected/);
    });
    it("validates selected output capture mapping rather than blindly using all Save branches", () => {
        const good=payload();
        expect(validateComfyTemplatePayload(good,info).ports[3].outputBinding).toEqual({nodeId:"20",outputIndex:0});
        good.ports[3].outputBinding={nodeId:"20",outputIndex:2};
        expect(() => validateComfyTemplatePayload(good,info)).toThrow(/output socket type mismatch/);
        good.ports[3].outputBinding={nodeId:"20",outputIndex:0};
        good.ports[3].capture={kind:"video",adapterId:"SaveVideo"};
        expect(() => validateComfyTemplatePayload(good)).toThrow(/capture requires/);
    });
    it("content SHA-256 is stable under object key reorder; modifying graph/port invalidates revision", async () => {
        const created=await createComfyTemplate("image-pipeline",payload(),info);
        expect(created.revision).toMatch(/^[0-9a-f]{64}$/);
        await expect(verifyComfyTemplate(created)).resolves.toBeUndefined();
        const tampered=structuredClone(created);tampered.apiGraph["10"].inputs.text="changed";
        await expect(verifyComfyTemplate(tampered)).rejects.toThrow(/SHA-256 mismatch/);
        expect(canonicalComfyJson({z:1,a:{y:2,x:3}})).toBe(canonicalComfyJson({a:{x:3,y:2},z:1}));
        expect(await comfySha256(canonicalComfyJson(payload()))).toBe(created.revision);
    });
});
