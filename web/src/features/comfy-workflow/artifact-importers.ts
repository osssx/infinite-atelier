import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createCanvasNode, imageMetadata, videoMetadata, audioMetadata } from "@/lib/canvas/canvas-node-factory";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { placeComfyImageArtifact } from "./artifact-layout";
import type { ComfyRunArtifact } from "./run-client";

export type ArtifactImporter = (artifact:ComfyRunArtifact,blob:Blob,source:CanvasNodeData,index:number)=>Promise<CanvasNodeData>;
const provenance=(artifact:ComfyRunArtifact)=>({
    runId:artifact.runId,artifactId:artifact.artifactId,workflowNodeId:artifact.workflowNodeId,
    portId:artifact.portId,kind:artifact.kind,index:artifact.index
});
function createPlacedNode(kind:CanvasNodeType,source:CanvasNodeData,index:number,
    width:number,height:number,metadata:CanvasNodeData["metadata"]) {
    const placement=placeComfyImageArtifact(source,index,width,height);
    const node=createCanvasNode(kind,placement.center,metadata);
    node.width=placement.width;node.height=placement.height;
    return node;
}
export const canvasArtifactImporters:Readonly<Record<ComfyRunArtifact["kind"],ArtifactImporter>>={
    image:async(artifact,blob,source,index)=>{
        const item=await uploadImage(blob);
        return createPlacedNode(CanvasNodeType.Image,source,index,item.width,item.height,{
            ...imageMetadata(item),comfyArtifact:provenance(artifact)
        });
    },
    video:async(artifact,blob,source,index)=>{
        const item=await uploadMediaFile(blob,"video");
        return createPlacedNode(CanvasNodeType.Video,source,index,item.width||1280,item.height||720,{
            ...videoMetadata(item),comfyArtifact:provenance(artifact)
        });
    },
    audio:async(artifact,blob,source,index)=>{
        const item=await uploadMediaFile(blob,"audio");
        return createPlacedNode(CanvasNodeType.Audio,source,index,520,220,{
            ...audioMetadata(item),comfyArtifact:provenance(artifact)
        });
    },
    text:async(artifact,blob,source,index)=>createPlacedNode(CanvasNodeType.Text,source,index,420,320,{
        content:await blob.text(),status:"success",comfyArtifact:provenance(artifact)
    }),
};
export async function importComfyArtifact(artifact:ComfyRunArtifact,blob:Blob,source:CanvasNodeData,index:number) {
    if(blob.type!==artifact.mimeType)throw new Error("ComfyUI 产物 MIME 不一致");
    const importer=canvasArtifactImporters[artifact.kind];
    if(!importer)throw new Error("未知的 ComfyUI 产物类型");
    return importer(artifact,blob,source,index);
}
