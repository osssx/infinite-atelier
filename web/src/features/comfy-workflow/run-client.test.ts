import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/image-storage",()=>({getImageBlob:vi.fn()}));
import { listComfyInstances } from "./run-client";

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
    it("handles unreachable Vite proxy and normal instance list",async()=>{
        vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
        await expect(listComfyInstances()).rejects.toThrow(/无法连接.*8787/);
        vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({
            instances:[{id:"comfy-local",reachable:true,classTypes:["SaveImage"]}]
        }),{headers:{"content-type":"application/json; charset=utf-8"}})));
        await expect(listComfyInstances()).resolves.toMatchObject([{id:"comfy-local",reachable:true}]);
    });
});
