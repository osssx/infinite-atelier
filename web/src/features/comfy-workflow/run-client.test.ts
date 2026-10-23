import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/image-storage",()=>({getImageBlob:vi.fn()}));
import { deleteComfyInstance, listComfyInstances, saveComfyInstance } from "./run-client";

afterEach(()=>vi.unstubAllGlobals());

describe("ComfyUI browser gateway responses",()=>{
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
