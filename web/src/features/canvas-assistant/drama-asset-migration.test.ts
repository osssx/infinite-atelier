import { describe, expect, it } from "vitest";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { mergeLegacyDramaAssets } from "./drama-asset-migration";

const key = "cas:" + "a".repeat(64);
const node = (id:string, type:string, metadata:CanvasNodeData["metadata"] = {}): CanvasNodeData =>
    ({id, type, title:id, position:{x:20,y:30}, width:340,height:400, metadata});
const edge = (fromNodeId:string,toNodeId:string): CanvasConnection =>
    ({id:`${fromNodeId}-${toNodeId}`,fromNodeId,toNodeId});
const nodes = [
    node("assets","drama:assets",{dramaDraft:'{"assets":[]}',dramaConfirmed:'{"assets":[]}'}),
    node("refs","drama:asset_references",{
        dramaDraft:JSON.stringify({references:[{assetId:"hero",variantId:"hero-day",imageStorageKey:key,requiredForRendering:true}]}),
        dramaConfirmed:'{"references":[]}',
    }),
    node("frames","drama:first_frames"),
    node("image","image"),
];
const edges = [edge("assets","refs"),edge("refs","frames"),edge("refs","image")];

describe("legacy drama asset merge", () => {
    it("preserves drafts and selected images and rewires the same outgoing edge IDs", () => {
        const result = mergeLegacyDramaAssets(nodes,edges);
        expect(result.changed).toBe(true);
        expect(result.nodes.map(item => item.id)).toEqual(["assets","frames","image"]);
        expect(result.nodes[0]).toMatchObject({...nodes[0], metadata:{
            ...nodes[0].metadata, dramaAssetReferences:[{assetId:"hero",variantId:"hero-day",imageStorageKeys:[key]}],
        }});
        expect(result.connections).toEqual(edges.slice(1).map(item => ({...item,fromNodeId:"assets"})));
        expect(mergeLegacyDramaAssets(result.nodes,result.connections).changed).toBe(false);
    });

    it("keeps shared and typed legacy connections intact", () => {
        const shared = [edge("second","refs"),...edges];
        expect(mergeLegacyDramaAssets([...nodes,node("second","drama:assets")],shared).connections).toBe(shared);
        const typed = [{...edges[0],fromPortId:"assets"},...edges.slice(1)];
        expect(mergeLegacyDramaAssets(nodes,typed).connections).toBe(typed);
    });

    it("keeps malformed reference data intact", () => {
        const invalid = nodes.map(item => item.id === "refs" ? {...item,metadata:{dramaDraft:"{"}} : item);
        expect(mergeLegacyDramaAssets(invalid,edges).nodes).toBe(invalid);
    });
});
