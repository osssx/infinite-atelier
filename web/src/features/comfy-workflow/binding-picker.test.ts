import { describe, expect, it } from "vitest";
import type { ComfyApiGraph, ComfyObjectInfo, ComfyTemplatePort } from "./template-schema";
import {inspectComfyInputSpec} from "./comfy-input-spec";
import {
    appendComfyInputTarget, bindingTargetKey, enumerateComfyGraphItems, filterComfyGraphItems,
    inferComfyBindingMode, inferComfyInputKind, parseBindingTargetKey, removeComfyInputTarget,
    resolveComfyInputBindingAction, toggleComfyPortSelection, usedComfyInputTarget,
} from "./binding-picker";

const graph:ComfyApiGraph = {
    "29":{class_type:"SaveImage",_meta:{title:"Final PNG"},inputs:{filename_prefix:"Preview",images:["21",0]}},
    "30.16":{class_type:"TextGenerate",inputs:{"sampling_mode.top.p":0.9,model:"qwen"}},
    "21":{class_type:"Sampler",inputs:{steps:22,seed:1,denoise:0.8,enabled:true,positive:["30.16",0]}},
};
const info:ComfyObjectInfo = {
    SaveImage:{input:{required:{filename_prefix:["STRING",{}],images:["IMAGE",{}]}},output:[]},
    TextGenerate:{input:{required:{"sampling_mode.top.p":["FLOAT",{}],model:["STRING",{}]}},output:["STRING"]},
    Sampler:{input:{required:{steps:["INT",{}],seed:["INT",{}],denoise:["FLOAT",{}],enabled:["BOOLEAN",{}],positive:["STRING",{}]}},output:["IMAGE","MASK"]},
};
const target=(nodeId:string,inputName:string)=>({nodeId,inputName});
const one:ComfyTemplatePort={id:"a",label:"Prompt",direction:"target",valueKind:"STRING",
    inputBinding:{mode:"literal",targets:[target("29","filename_prefix")]}};
const two:ComfyTemplatePort={id:"b",label:"Second",direction:"target",valueKind:"STRING",
    inputBinding:{mode:"literal",targets:[]}};

describe("Comfy binding picker interactive selection",()=>{
    it("deselects on second click so left-side parameters create new input ports",()=>{
        let selected:string|null=null;
        selected=toggleComfyPortSelection(selected,"a");
        expect(selected).toBe("a");
        expect(resolveComfyInputBindingAction([one,two],selected,target("21","steps")))
            .toEqual({kind:"append",portId:"a"});
        // Clicking the selected canvas port again is an explicit deselection.
        selected=toggleComfyPortSelection(selected,"a");
        expect(selected).toBeNull();
        expect(resolveComfyInputBindingAction([one,two],selected,target("21","steps")))
            .toEqual({kind:"create"});
        // Clicking a new Comfy field now creates an independent port and leaves
        // the original input's mapping intact.
        const newPort:ComfyTemplatePort={id:"steps",label:"steps",direction:"target",
            valueKind:"INT",inputBinding:{mode:"literal",targets:[target("21","steps")]}};
        const ports=[one,two,newPort];
        expect(ports[0].inputBinding?.targets).toEqual([target("29","filename_prefix")]);
        expect(ports[2].inputBinding?.targets).toEqual([target("21","steps")]);
        expect(resolveComfyInputBindingAction(ports,selected,target("21","steps")))
            .toEqual({kind:"existing",portId:"steps"});
    });
    it("keeps intentional multiple mappings when selected and routes existing targets to their owner",()=>{
        expect(toggleComfyPortSelection("a","b")).toBe("b");
        const second=target("21","seed");
        expect(resolveComfyInputBindingAction([one,two],"a",second))
            .toEqual({kind:"append",portId:"a"});
        const multi=appendComfyInputTarget([one,two],"a",second);
        expect(multi[0].inputBinding?.targets).toHaveLength(2);
        expect(resolveComfyInputBindingAction(multi,"a",second))
            .toEqual({kind:"existing",portId:"a"});
        expect(resolveComfyInputBindingAction(multi,null,target("29","filename_prefix")))
            .toEqual({kind:"existing",portId:"a"});
        const output:ComfyTemplatePort={id:"result",label:"Result",direction:"source",
            valueKind:"IMAGE",outputBinding:{nodeId:"21",outputIndex:0},capture:{kind:"none"}};
        expect(resolveComfyInputBindingAction([...multi,output],"result",target("21","denoise")))
            .toEqual({kind:"create"});
        expect(resolveComfyInputBindingAction([one,two],"deleted",target("21","denoise")))
            .toEqual({kind:"create"});
    });
    it("lists parsed graph nodes with titles, editable inputs, and /object_info output socket types",()=>{
        const items=enumerateComfyGraphItems(graph,info);
        expect(items).toHaveLength(3);
        expect(items.find((item)=>item.id==="29")?.title).toBe("Final PNG");
        expect(items.find((item)=>item.id==="29")?.fields.map((f)=>f.name)).toEqual(["filename_prefix","images"]);
        expect(items.find((item)=>item.id==="21")?.outputs).toEqual([{index:0,valueKind:"IMAGE"},{index:1,valueKind:"MASK"}]);
    });
    it("search matches class name, node id, display title and parameter names without dropping others",()=>{
        const items=enumerateComfyGraphItems(graph,info);
        expect(filterComfyGraphItems(items,"saveimage").map((n)=>n.id)).toEqual(["29"]);
        expect(filterComfyGraphItems(items,"30.16").map((n)=>n.id)).toEqual(["30.16"]);
        expect(filterComfyGraphItems(items,"SAMPLING_MODE").map((n)=>n.id)).toEqual(["30.16"]);
        expect(filterComfyGraphItems(items,"").length).toBe(3);
    });
    it("recognizes COMBO as a string enum and exposes actual values for the editor",()=>{
        const options=["1:1 (Square)","3:4 (Portrait Standard)","16:9 (Widescreen)"];
        const descriptor=inspectComfyInputSpec(["COMBO",{options,default:options[0]}]);
        expect(descriptor.declaredType).toBe("COMBO");
        expect(descriptor.valueKind).toBe("STRING");
        expect(descriptor.choices).toEqual(options.map(value=>({label:value,value})));
        const standard=inspectComfyInputSpec([options,{}]);
        expect(standard.valueKind).toBe("STRING");
        const actual:ComfyApiGraph={"19":{class_type:"ResolutionSelector",inputs:{aspect_ratio:options[0]}}};
        const definitions:ComfyObjectInfo={ResolutionSelector:{
            input:{required:{aspect_ratio:["COMBO",{options}]}}}};
        expect(enumerateComfyGraphItems(actual,definitions)[0].fields[0].declaredType).toBe("COMBO (STRING)");
        expect(inferComfyInputKind(options[0],descriptor.valueKind)).toBe("STRING");
        expect(inspectComfyInputSpec(["COMBO",{options:[16,32]}]).valueKind).toBe("INT");
        expect(inspectComfyInputSpec(["COMBO",{options:[16,32.5]}]).valueKind).toBe("FLOAT");
        expect(inspectComfyInputSpec(["COMBO",{options:[]}]).valueKind).toBeUndefined();
    });
    it("assigns one canvas input to several different internal Comfy parameters",()=>{
        const result=appendComfyInputTarget([one,two],"a",target("30.16","sampling_mode.top.p"));
        expect(result[0].inputBinding?.targets).toHaveLength(2);
        expect(usedComfyInputTarget(result,target("30.16","sampling_mode.top.p"))).toBe("a");
        expect(appendComfyInputTarget(result,"a",target("30.16","sampling_mode.top.p"))).toEqual(result);
        const removed=removeComfyInputTarget(result,"a",target("29","filename_prefix"));
        expect(removed[0].inputBinding?.targets).toEqual([target("30.16","sampling_mode.top.p")]);
    });
    it("rejects another canvas input claiming the same internal Comfy input without overwriting",()=>{
        expect(()=>appendComfyInputTarget([one,two],"b",target("29","filename_prefix"))).toThrow(/already assigned/);
        expect(one.inputBinding?.targets).toEqual([target("29","filename_prefix")]);
        expect(()=>appendComfyInputTarget([one,two],"missing",target("29","images"))).toThrow(/Choose a canvas input port/);
    });
    it("uses opaque JSON keys for node and field names containing dots (not nodeId.field splitting)",()=>{
        const key=bindingTargetKey(target("30.16","sampling_mode.top.p"));
        expect(parseBindingTargetKey(key)).toEqual(target("30.16","sampling_mode.top.p"));
        expect(()=>parseBindingTargetKey(JSON.stringify(["node"]))).toThrow(/Invalid/);
    });
    it("infers scalar and socket inputs from graph values, with authoritative types preferred",()=>{
        expect(inferComfyInputKind("text")).toBe("STRING");
        expect(inferComfyInputKind(0)).toBe("INT");
        expect(inferComfyInputKind(0.2)).toBe("FLOAT");
        expect(inferComfyInputKind(false)).toBe("BOOLEAN");
        expect(inferComfyInputKind(["21",0],"STRING")).toBe("STRING");
        expect(inferComfyBindingMode(["21",0])).toBe("socket");
        expect(inferComfyBindingMode("value")).toBe("literal");
    });
});
