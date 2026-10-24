import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/image-storage",()=>({getImageBlob:vi.fn()}));
import { deleteComfyInstance, hasPendingComfyRun, listComfyInstances, missingComfyMediaInputs, recoverPendingComfyRun, saveComfyInstance, startComfyWorkflowRun } from "./run-client";
import type { CanvasNodeData } from "@/types/canvas";
import type { ComfyWorkflowTemplate } from "./template-schema";

afterEach(()=>vi.unstubAllGlobals());

describe("Comfy media input preflight and submission recovery",()=>{
    function stubPendingStorage() {
        const map=new Map<string,string>();
        const storage={
            getItem:(key:string)=>map.get(key)??null,
            setItem:(key:string,value:string)=>{map.set(key,value);},
            removeItem:(key:string)=>{map.delete(key);},
        };
        vi.stubGlobal("localStorage",storage);
        return storage;
    }
    const template:ComfyWorkflowTemplate={
        id:"minimax",revision:"a".repeat(64),name:"MiniMax H3 I2V",
        apiGraph:{"114":{class_type:"LoadImage",inputs:{image:"example.png"}}},
        requirements:{classTypes:["LoadImage"]},
        ports:[
            {id:"first_frame",label:"首帧图片",direction:"target",valueKind:"IMAGE",required:true,
                inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"114",inputName:"image"}]},
                absentPolicy:{mode:"keep-template"}},
            {id:"video",label:"生成视频",direction:"source",valueKind:"VIDEO",
                outputBinding:{nodeId:"114",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}}
        ]
    };
    const workflowNode:CanvasNodeData={
        id:"wf",type:"comfy:workflow",title:"Video",position:{x:0,y:0},width:400,height:220,
        metadata:{comfyWorkflow:{templateId:"minimax",templateRevision:template.revision,bindingState:"bound",inputOverrides:{}}}
    };
    it("explains the required first_frame connection before staging or writing pending requests",async()=>{
        const storage=stubPendingStorage();
        const fetchMock=vi.fn();
        vi.stubGlobal("fetch",fetchMock);
        expect(missingComfyMediaInputs(template,"wf",[]).map(p=>p.id)).toEqual(["first_frame"]);
        expect(missingComfyMediaInputs(template,"wf",[{
            id:"edge",fromNodeId:"image",fromPortId:"image",toNodeId:"wf",toPortId:"first_frame"
        }])).toEqual([]);
        await expect(startComfyWorkflowRun({
            projectId:"p",workflowNode,nodes:[workflowNode],connections:[],
            template,instanceId:"comfy-local",outputPortIds:["video"]
        })).rejects.toThrow(/连接媒体输入：首帧图片 \(first_frame\)/);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(storage.getItem("comfy_pending_v2:p:wf")).toBeNull();
    });
    it.each(["untrusted_template_file:first_frame","media_input_requires_connection:first_frame"])(
        "clears a rejected stale snapshot %s, and translates the error",async(code)=>{
            const storage=stubPendingStorage(),key="comfy_pending_v2:p:wf";
            storage.setItem(key,JSON.stringify({schemaVersion:2,idempotencyKey:"one"}));
            vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:code}),{
                status:422,headers:{"content-type":"application/json"}
            })));
            await expect(recoverPendingComfyRun("p","wf")).rejects.toThrow(/缺少工作流媒体输入 first_frame/);
            expect(storage.getItem(key)).toBeNull();
            expect(hasPendingComfyRun("p","wf")).toBe(false);
        }
    );
    it("retains exact pending payload on gateway timeout/5xx (no duplicate GPU submission)",async()=>{
        const storage=stubPendingStorage(),key="comfy_pending_v2:p:wf";
        const payload=JSON.stringify({idempotencyKey:"same-key"});
        storage.setItem(key,payload);
        vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:"upstream_unavailable"}),{
            status:503,headers:{"content-type":"application/json"}
        })));
        await expect(recoverPendingComfyRun("p","wf")).rejects.toThrow(/upstream_unavailable/);
        expect(storage.getItem(key)).toBe(payload);
        expect(hasPendingComfyRun("p","wf")).toBe(true);
    });
});


describe("ComfyUI browser gateway responses",()=>{
    it.each([
        ["missing","ComfyUI 当前实例没有找到 LoRA 模型"],
        ["ambiguous","ComfyUI 中有多个同名 LoRA"],
    ])("explains unavailable or ambiguous LoRA choices (%s)",async(type,message)=>{
        vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({
            error:"comfy_model_"+type+":LoraLoaderModelOnly.lora_name:kera2\\test.safetensors"
        }),{status:422,headers:{"content-type":"application/json"}})));
        await expect(listComfyInstances()).rejects.toThrow(message);
    });
    it("explains a Vite proxy / missing gateway 502 instead of invalid JSON",async()=>{
        vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("<html>Bad Gateway</html>",{
            status:502,headers:{"content-type":"text/html"}
        })));
        await expect(listComfyInstances()).rejects.toThrow(/网关不可用.*8787/);
    });
    it("recognizes an SPA HTML fallback even when it responds 200",async()=>{
        vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("<html>SPA</html>",{
            status:200,headers:{"content-type":"text/html"}
        })));
        await expect(listComfyInstances()).rejects.toThrow(/非 JSON.*前端页面/);
    });
    it("explains missing or mismatched gateway credentials",async()=>{
        vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response('{"error":"Unauthorized"}',{
            status:401,headers:{"content-type":"application/json"}
        })));
        await expect(listComfyInstances()).rejects.toThrow(/鉴权失败.*GATEWAY_TOKEN/);
    });

    it("identifies an older live gateway from missing instance-management capability",async()=>{
        vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({
            instances:[{id:"comfy-local",reachable:false,classTypes:[]}]
        }),{headers:{"content-type":"application/json"}})));
        await expect(listComfyInstances()).rejects.toThrow(/网关版本过旧.*重新运行 npm run dev:comfy/);
    });
    it("turns the real old PUT route 404 into a restart instruction",async()=>{
        const fetchMock=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({error:"comfy_route_not_found"}),{
            status:404,headers:{"content-type":"application/json"}
        }));
        vi.stubGlobal("fetch",fetchMock);
        await expect(saveComfyInstance("comfy-local","http://127.0.0.1:8188","comfy-local"))
            .rejects.toThrow(/网关版本过旧.*重新运行 npm run dev:comfy/);
        expect(fetchMock).toHaveBeenCalledWith("/api/comfy/instances/comfy-local",expect.objectContaining({
            method:"PUT",body:JSON.stringify({id:"comfy-local",url:"http://127.0.0.1:8188"})
        }));
        await expect(deleteComfyInstance("comfy-local")).rejects.toThrow(/网关版本过旧.*重新运行 npm run dev:comfy/);
    });
    it("accepts a new gateway and successfully stores an edited instance",async()=>{
        const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({
            instance:{id:"comfy-local",url:"http://127.0.0.1:8189"}
        }),{headers:{"content-type":"application/json"}}));
        vi.stubGlobal("fetch",fetchMock);
        await expect(saveComfyInstance("comfy-local","http://127.0.0.1:8189","comfy-local"))
            .resolves.toMatchObject({instance:{url:"http://127.0.0.1:8189"}});
    });
    it("handles unreachable Vite proxy and normal instance list",async()=>{
        vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
        await expect(listComfyInstances()).rejects.toThrow(/无法连接.*8787/);
        vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({
            apiVersion:2,instanceManagement:true,instances:[{id:"comfy-local",url:"http://127.0.0.1:8188",reachable:true,classTypes:["SaveImage"]}]
        }),{headers:{"content-type":"application/json; charset=utf-8"}})));
        await expect(listComfyInstances()).resolves.toMatchObject([{id:"comfy-local",reachable:true}]);
    });
});
