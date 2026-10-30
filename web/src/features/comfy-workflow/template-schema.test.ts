import { describe, expect, it } from "vitest";
import {
    ComfyTemplateBindingError, canonicalComfyJson, comfySha256, createComfyTemplate, templatePayloadFromGraph,
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
    it("persists optional canvas visibility in immutable versions without changing input bindings", async () => {
        const source = payload();
        const original = validateComfyTemplatePayload(source, info);
        expect(original.ports[0].canvasVisible).toBeUndefined(); // omitted => shown
        source.ports[0].canvasVisible = false;
        const updated = validateComfyTemplatePayload(source, info);
        expect(updated.ports[0].canvasVisible).toBe(false);
        const version = await createComfyTemplate("visibility-example", source, info);
        await expect(verifyComfyTemplate(version)).resolves.toBeUndefined();
        expect(version.ports[0].canvasVisible).toBe(false);
        expect(version.ports[0].inputBinding).toEqual(source.ports[0].inputBinding);
        const required = payload();
        required.ports[0].required = true;
        required.ports[0].canvasVisible = false;
        expect(() => validateComfyTemplatePayload(required, info)).toThrow(/only optional canvas-connectable/);
        const numeric = payload();
        numeric.ports[1].canvasVisible = false;
        expect(() => validateComfyTemplatePayload(numeric, info)).toThrow(/only optional canvas-connectable/);
        const output = payload();
        output.ports[3].canvasVisible = false;
        expect(() => validateComfyTemplatePayload(output, info)).toThrow(/only optional canvas-connectable/);
        const malformed = payload();
        malformed.ports[0].canvasVisible = "false" as unknown as boolean;
        expect(() => validateComfyTemplatePayload(malformed, info)).toThrow(/invalid port visibility/);
    });
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
    it("handles ComfyMathExpression COMFY_AUTOGROW_V3 named leaves, not a literal parent",()=>{
        const descriptor:ComfyObjectInfo={
            PrimitiveFloat:{input:{required:{value:["FLOAT",{}]}},output:["FLOAT"]},
            ComfyMathExpression:{input:{required:{
                expression:["STRING",{}],
                values:["COMFY_AUTOGROW_V3",{template:{names:["a","b","c"],min:1,
                    input:{required:{value:["FLOAT,INT,BOOLEAN",{}]}}}}]
            }},output:["FLOAT","INT","BOOLEAN"]}
        };
        const graph={
            "1":{class_type:"PrimitiveFloat",inputs:{value:5}},
            "2":{class_type:"ComfyMathExpression",inputs:{expression:"a * 2","values.a":["1",0]}}
        };
        expect(() => validateComfyApiGraph(graph,descriptor)).not.toThrow();
        const unknown=structuredClone(graph) as Record<string,{class_type:string;inputs:Record<string,unknown>}>;
        unknown["2"].inputs["values.z"]=7;
        expect(() => validateComfyApiGraph(unknown,descriptor)).toThrow(/unknown input 2.values.z/);
        delete unknown["2"].inputs["values.z"];
        delete unknown["2"].inputs["values.a"];
        expect(() => validateComfyApiGraph(unknown,descriptor)).toThrow(/required field missing: 2.values.a/);
        unknown["2"].inputs.values={a:5};
        expect(() => validateComfyApiGraph(unknown,descriptor)).toThrow(/unknown input 2.values/);
    });
    it("handles COMFY_AUTOGROW_V3 prefix with min and max",()=>{
        const descriptor:ComfyObjectInfo={
            Grow:{input:{required:{values:["COMFY_AUTOGROW_V3",{template:{
                prefix:"input",max:3,min:1,input:{required:{value:["INT",{}]}}
            }}]}},output:["INT"]}
        };
        const graph={"1":{class_type:"Grow",inputs:{"values.input0":5,"values.input2":7}}};
        expect(() => validateComfyApiGraph(graph,descriptor)).not.toThrow();
        expect(() => validateComfyApiGraph({"1":{class_type:"Grow",inputs:{"values.input3":5}}},descriptor))
            .toThrow(/unknown input 1.values.input3/);
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
    it("identifies the exact literal type mismatch, bound field and expected type without leaking prompts",()=>{
        const broken=payload();
        // The saved API workflow contains a prompt; never expose that source text in errors.
        broken.apiGraph["10"].inputs.text="private prompt never display";
        broken.ports[0].valueKind="INT";
        let error:unknown;
        try{validateComfyTemplatePayload(broken,info);}catch(e){error=e;}
        expect(error).toBeInstanceOf(ComfyTemplateBindingError);
        const issue=error as ComfyTemplateBindingError;
        expect(issue.portId).toBe("prompt");
        expect(issue.nodeId).toBe("10");
        expect(issue.inputName).toBe("text");
        expect(issue.message).toContain("literal type mismatch");
        expect(issue.message).toContain("画布端口");
        expect(issue.message).toContain('"Prompt"（prompt）');
        expect(issue.message).toContain("节点 10（Prompt）参数 text");
        expect(issue.message).toContain("节点要求 STRING，当前端口设置为 INT");
        expect(issue.message).toContain("字符串（长度");
        expect(issue.message).not.toContain("private prompt never display");
    });
    it("reports the failing parameter when one canvas port maps to several ComfyUI inputs",()=>{
        const broken=payload();
        broken.ports[0].inputBinding!.targets.push({nodeId:"20",inputName:"strength"});
        expect(()=>validateComfyTemplatePayload(broken,info)).toThrow(/节点 20（Images）参数 strength.*节点要求 FLOAT，当前端口设置为 STRING/);
        try{validateComfyTemplatePayload(broken,info);}catch(e){
            expect(e).toBeInstanceOf(ComfyTemplateBindingError);
            const issue=e as ComfyTemplateBindingError;
            expect(issue.portId).toBe("prompt");
            expect(issue.nodeId).toBe("20");
            expect(issue.inputName).toBe("strength");
        }
    });
    it("also locates socket, default-value and output socket errors",()=>{
        const socket=payload();
        socket.ports[0].valueKind="FLOAT";
        socket.ports[0].inputBinding={mode:"socket",replaceInternalLink:true,targets:[{nodeId:"10",inputName:"text"}]};
        expect(()=>validateComfyTemplatePayload(socket,info)).toThrow(/socket type mismatch.*节点 10（Prompt）参数 text.*节点要求 STRING，当前端口设置为 FLOAT/);
        const invalidDefault=payload();
        invalidDefault.ports[1].defaultValue="not-a-number";
        expect(()=>validateComfyTemplatePayload(invalidDefault,info)).toThrow(/default value type mismatch.*端口要求 FLOAT，默认值为 字符串（长度/);
        const wrongOutput=payload();
        wrongOutput.ports[3].valueKind="VIDEO";
        try{validateComfyTemplatePayload(wrongOutput,info);}catch(e){
            expect(e).toBeInstanceOf(ComfyTemplateBindingError);
            const issue=e as ComfyTemplateBindingError;
            expect(issue.portId).toBe("output");
            expect(issue.nodeId).toBe("20");
            expect(issue.message).toMatch(/output socket type mismatch.*输出 \[0\].*节点类型 IMAGE，当前端口设置为 VIDEO/);
        }
    });
    it("shows numeric type diagnostics without changing the strict declared INT/FLOAT validation",()=>{
        const broken=payload();
        broken.ports[1].valueKind="INT";
        // API graph has 0.3, but real object_info requires FLOAT.
        expect(()=>validateComfyTemplatePayload(broken,info)).toThrow(/节点 20（Images）参数 strength.*节点要求 FLOAT，当前端口设置为 INT.*小数（0.3）/);
        expect(validateComfyTemplatePayload(payload(),info).ports).toHaveLength(4);
    });
    it("binds ResolutionSelector.aspect_ratio COMBO strings as a STRING literal, without weakening numeric type checks",async()=>{
        const source=payload();
        const comboOptions=["1:1 (Square)","2:3 (Portrait Photo)","3:2 (Photo)",
            "3:4 (Portrait Standard)","4:3 (Standard)","9:16 (Portrait Widescreen)",
            "16:9 (Widescreen)","21:9 (Ultrawide)"];
        source.apiGraph["19"]={class_type:"ResolutionSelector",inputs:{
            aspect_ratio:"1:1 (Square)",megapixels:1.5,multiple:16
        },_meta:{title:"分辨率选择器"}};
        source.requirements.classTypes=[...source.requirements.classTypes,"ResolutionSelector"].sort();
        source.ports.push({id:"aspect_ratio",label:"画面比例",direction:"target",valueKind:"STRING",
            inputBinding:{mode:"literal",targets:[{nodeId:"19",inputName:"aspect_ratio"}]},
            choices:comboOptions.map(value=>({label:value,value}))});
        const definitions:ComfyObjectInfo={...info,ResolutionSelector:{input:{required:{
            aspect_ratio:["COMBO",{default:comboOptions[0],multiselect:false,options:comboOptions}],
            megapixels:["FLOAT",{}],multiple:["INT",{}]
        }},output:["INT","INT"]}};
        expect(validateComfyTemplatePayload(source,definitions).ports.at(-1)?.choices?.length).toBe(8);
        const version=await createComfyTemplate("moss-combo-aspect-ratio",source,definitions);
        await expect(verifyComfyTemplate(version)).resolves.toBeUndefined();
        const mismatch=structuredClone(source);
        mismatch.ports.at(-1)!.valueKind="INT";
        expect(()=>validateComfyTemplatePayload(mismatch,definitions))
            .toThrow(/literal type mismatch.*节点要求 STRING（COMBO 枚举值），当前端口设置为 INT/);
        const strict=structuredClone(source);
        strict.ports.push({id:"megapixels",label:"分辨率",direction:"target",valueKind:"STRING",
            inputBinding:{mode:"literal",targets:[{nodeId:"19",inputName:"megapixels"}]}});
        expect(()=>validateComfyTemplatePayload(strict,definitions))
            .toThrow(/literal type mismatch.*节点要求 FLOAT，当前端口设置为 STRING/);
    });
    it("accepts standard ComfyUI array enums as STRING and refuses mismatched kinds",()=>{
        const original=payload();
        original.apiGraph["19"]={class_type:"ResolutionSelector",inputs:{aspect_ratio:"1:1 (Square)"}};
        original.requirements.classTypes.push("ResolutionSelector");
        original.requirements.classTypes.sort();
        original.ports.push({id:"aspect",label:"Aspect",direction:"target",valueKind:"STRING",
            inputBinding:{mode:"literal",targets:[{nodeId:"19",inputName:"aspect_ratio"}]}});
        const definitions:ComfyObjectInfo={...info,ResolutionSelector:{input:{required:{
            aspect_ratio:[["1:1 (Square)","16:9 (Widescreen)"],{}]
        }},output:[]}};
        expect(()=>validateComfyTemplatePayload(original,definitions)).not.toThrow();
        original.ports.at(-1)!.valueKind="BOOLEAN";
        expect(()=>validateComfyTemplatePayload(original,definitions)).toThrow(/literal type mismatch/);
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
    it("preserves typed STRING/FLOAT choice lists across immutable template revisions",async()=>{
        const sample=payload();
        sample.ports[0].choices=[{label:"快速",value:"fast"},{label:"慢速",value:"slow"}];
        sample.ports[1].choices=[{label:"精确",value:0.25},{label:"宽松",value:0.75}];
        sample.ports[1].defaultValue=0.25;
        const created=await createComfyTemplate("choice-sample",sample);
        expect(created.ports[0].choices).toEqual(sample.ports[0].choices);
        expect(created.ports[1].choices).toEqual(sample.ports[1].choices);
        await expect(verifyComfyTemplate(created)).resolves.toBeUndefined();
        const updated=structuredClone(sample);
        updated.ports[0].choices![0].label="极速";
        expect((await createComfyTemplate("choice-sample",updated)).revision).not.toBe(created.revision);
    });
    it("fails closed on invalid choice type, duplicate, default mismatch and non-scalar bindings",()=>{
        const sample=payload();
        sample.ports[0].choices=[{label:"A",value:"ok"},{label:"B",value:"ok"}];
        expect(()=>validateComfyTemplatePayload(sample)).toThrow(/duplicate enum choice/);
        sample.ports[0].choices=[{label:"A",value:1}];
        expect(()=>validateComfyTemplatePayload(sample)).toThrow(/label\/value type mismatch/);
        sample.ports[0].choices=[{label:"A",value:"ok"}];
        sample.ports[0].defaultValue="not-a-choice";
        expect(()=>validateComfyTemplatePayload(sample)).toThrow(/default value must match/);
        delete sample.ports[0].defaultValue;
        sample.ports[2].choices=[{label:"bad",value:"x"}];
        expect(()=>validateComfyTemplatePayload(sample)).toThrow(/enum choices require/);
        delete sample.ports[2].choices;
        sample.ports[0].inputBinding={mode:"socket",replaceInternalLink:true,targets:[{nodeId:"10",inputName:"text"}]};
        expect(()=>validateComfyTemplatePayload(sample)).toThrow(/enum choices require/);
        sample.ports[0].inputBinding={mode:"literal",targets:[{nodeId:"10",inputName:"text"}]};
        sample.ports[0].choices=Array.from({length:65},(_,i)=>({label:String(i),value:String(i)}));
        expect(()=>validateComfyTemplatePayload(sample)).toThrow(/1–64 choices/);
    });
    it("persists media auto-prune on one input port, not a workflow-level mode route",async()=>{
        const sample=payload();
        sample.ports[2].absentPolicy={mode:"auto-prune"};
        const created=await createComfyTemplate("media-optional",sample);
        expect(created.ports[2].absentPolicy).toEqual({mode:"auto-prune"});
        expect(created).not.toHaveProperty("dynamicRoutes");
        await expect(verifyComfyTemplate(created)).resolves.toBeUndefined();
        const legacy=payload();
        expect((await createComfyTemplate("media-optional",legacy)).revision).not.toBe(created.revision);
        sample.ports[2].required=true;
        expect(()=>validateComfyTemplatePayload(sample)).toThrow(/automatic pruning requires/);
        sample.ports[2].required=false;
        sample.ports[2].defaultValue="sample.png";
        expect(()=>validateComfyTemplatePayload(sample)).toThrow(/without a default/);
        delete sample.ports[2].defaultValue;
        sample.ports[0].absentPolicy={mode:"auto-prune"};
        expect(()=>validateComfyTemplatePayload(sample)).toThrow(/automatic pruning requires/);
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
