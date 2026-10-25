import { beforeEach,describe,expect,it,vi } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ComfyRunArtifact } from "./run-client";

vi.mock("@/features/backend-sync/canvas-media",()=>({
    uploadCanvasImage:vi.fn(async()=>({
      url:"/api/v1/blobs/abc",storageKey:"cas:"+"a".repeat(64),width:256,height:128,bytes:8,mimeType:"image/png"
    })),
    uploadCanvasMedia:vi.fn(async(_blob:Blob,kind:string)=>({
      url:"/api/v1/blobs/def",storageKey:"cas:"+"b".repeat(64),width:1280,height:720,durationMs:2000,bytes:64,
      mimeType:kind==="video"?"video/mp4":"audio/wav"
    }))
}));
vi.mock("@/lib/canvas/canvas-node-factory",()=>({
    createCanvasNode:vi.fn((type:CanvasNodeType,position:{x:number;y:number},metadata:unknown)=>({
        id:"node-"+type,type,title:type,position,width:100,height:100,metadata
    })),
    imageMetadata:(item:unknown)=>item,
    videoMetadata:(item:unknown)=>item,
    audioMetadata:(item:unknown)=>item,
}));
import { importComfyArtifact } from "./artifact-importers";
import { uploadCanvasImage,uploadCanvasMedia } from "@/features/backend-sync/canvas-media";

const workflow:CanvasNodeData={
    id:"workflow-1",type:"comfy:workflow",title:"Comfy",position:{x:100,y:100},width:320,height:210
};
const artifact=(kind:ComfyRunArtifact["kind"],portId:string,index=0):ComfyRunArtifact=>({
    artifactId:"artifact-"+portId,runId:"run-1",workflowNodeId:"workflow-1",portId,kind,index,
    mimeType:({image:"image/png",video:"video/mp4",audio:"audio/wav",text:"text/plain"})[kind],
    sha256:"a".repeat(64),byteSize:4,url:"/api/comfy/runs/run-1/artifacts/a"
});
describe("Comfy canvas artifact import adapters",()=>{
    beforeEach(()=>vi.clearAllMocks());
    it.each([
        ["image","image",CanvasNodeType.Image],
        ["video","video",CanvasNodeType.Video],
        ["audio","audio",CanvasNodeType.Audio],
        ["text","text",CanvasNodeType.Text],
    ] as const)("imports %s as %s node",async(kind,port,nodeType)=>{
        const item=artifact(kind,port,3);
        const blob=new Blob(["model result"],{type:item.mimeType});
        const node=await importComfyArtifact(item,blob,workflow,2);
        expect(node.type).toBe(nodeType);
        expect(node.metadata?.comfyArtifact).toEqual({
            runId:"run-1",artifactId:"artifact-"+port,workflowNodeId:"workflow-1",
            portId:port,kind,index:3
        });
        if(kind==="image")expect(uploadCanvasImage).toHaveBeenCalledOnce();
        if(kind==="video" || kind==="audio")expect(uploadCanvasMedia).toHaveBeenCalledWith(blob,kind);
        if(kind==="text")expect(node.metadata?.content).toBe("model result");
    });
    it("rejects a mismatched media content type before persisting",async()=>{
        await expect(importComfyArtifact(artifact("video","video"),new Blob(["x"],{type:"image/png"}),workflow,0))
            .rejects.toThrow(/MIME/);
        expect(uploadCanvasMedia).not.toHaveBeenCalled();
    });
});
