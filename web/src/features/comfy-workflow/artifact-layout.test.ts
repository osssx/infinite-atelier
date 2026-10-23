import { describe, expect, it } from "vitest";
import { placeComfyImageArtifact } from "./artifact-layout";
import type { CanvasNodeData } from "@/types/canvas";

const workflow: CanvasNodeData = {
    id:"wf",type:"comfy:workflow",title:"workflow",position:{x:100,y:200},width:400,height:220,
};
describe("Comfy multi-image artifact canvas placement",()=>{
    it("lays out all images of a batch without overlapping, including the fifth image",()=>{
        const results=Array.from({length:10},(_,i)=>placeComfyImageArtifact(workflow,i,1280,720));
        for(let i=0;i<results.length;i++)for(let j=i+1;j<results.length;j++){
            const a=results[i],b=results[j];
            const overlapX=Math.abs(a.center.x-b.center.x)<(a.width+b.width)/2;
            const overlapY=Math.abs(a.center.y-b.center.y)<(a.height+b.height)/2;
            expect(overlapX && overlapY).toBe(false);
        }
        expect(results[0].width).toBe(420);
        expect(results[0].height).toBeCloseTo(236.25);
        expect(results[4].center.x).toBeGreaterThan(results[0].center.x);
    });
    it("preserves small image dimensions and puts the first result right of its workflow",()=>{
        const first=placeComfyImageArtifact(workflow,0,256,256);
        expect(first.width).toBe(256);
        expect(first.height).toBe(256);
        expect(first.center.x-first.width/2).toBe(workflow.position.x+workflow.width+48);
    });
});
