import {describe,expect,it} from "vitest";
import {resolveCanvasComfyInstance} from "./canvas-instance";
import type {CanvasNodeData} from "@/types/canvas";
const node=(id:string,instanceId?:string):CanvasNodeData=>({
    id,type:"comfy:workflow",title:"WF",width:100,height:100,position:{x:0,y:0},
    metadata:{comfyWorkflow:{templateId:"t",templateRevision:"r",instanceId,bindingState:"bound",inputOverrides:{}}},
});
describe("canvas-wide ComfyUI instance migration",()=>{
    it("uses the persisted canvas selection over old node selections",()=>{
        expect(resolveCanvasComfyInstance({comfyInstanceId:"preferred",nodes:[node("1","legacy")]})).toBe("preferred");
    });
    it("migrates a unique legacy instance from one or more nodes",()=>{
        expect(resolveCanvasComfyInstance({nodes:[node("1","comfy-local"),node("2","comfy-local")]})).toBe("comfy-local");
    });
    it("refuses to guess when previous nodes targeted different instances",()=>{
        expect(resolveCanvasComfyInstance({nodes:[node("1","a"),node("2","b")]})).toBeUndefined();
        expect(resolveCanvasComfyInstance({nodes:[]})).toBeUndefined();
    });
});
