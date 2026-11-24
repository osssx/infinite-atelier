// @vitest-environment happy-dom
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildDramaVideoConfigGraph,refreshDramaVideoConfig,refreshDramaVideoConfigGraph } from "./drama-video-config";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { describe, expect, it } from "vitest";
import { applyDramaProduction,buildDramaVideoInput, dramaVideoMissingReferenceIds } from "./drama-pipeline-media";
import type { DramaPipelineSnapshot } from "./canvas-drama-pipeline";

const snapshot: DramaPipelineSnapshot = {
    version: 1, stage: "storyboard", revision: 1, inputRevisions: {},
    assets: [
        { id: "hero", kind: "character", name: "主角", description: "角色", sourceRefs: [], variants: [{ id: "hero-day", name: "日常", description: "蓝衣" }] },
        { id: "bridge", kind: "scene", name: "石桥", description: "雨桥", sourceRefs: [], variants: [{ id: "bridge-rain", name: "暴雨", description: "雨天" }] },
        { id: "star", kind: "prop", name: "星星", description: "道具", sourceRefs: [] },
    ],
    references: [
        { assetId: "hero", variantId: "hero-day", imageStorageKey: "cas:" + "a".repeat(64), requiredForRendering: true },
        { assetId: "bridge", variantId: "bridge-rain", imageStorageKey: "cas:" + "b".repeat(64), requiredForRendering: true },
        { assetId: "star", imageStorageKey: "cas:" + "c".repeat(64), requiredForRendering: true },
    ],
    shots: [],
};

it("creates fully typed Comfy image connections while retaining an untyped storyboard provenance edge",()=>{
 const source=createCanvasNode("drama:storyboard",{x:0,y:0},{dramaConfirmedVersionId:"published"});
 const input=applyDramaProduction(buildDramaVideoInput(snapshot,{id:"typed",episodeId:"ep",order:1,description:"Move",characterVariantIds:[],propIds:[],keyPropIds:[]}),{mode:"first_frame",firstFrame:"cas:"+"d".repeat(64)});
 const prepared={...input,comfyBinding:{templateId:"video",templateRevision:"a".repeat(64),mediaMode:"first_frame" as const,overrides:{},slots:{opening:{nodeId:input.referenceImages[0].id}}}};
 const graph=buildDramaVideoConfigGraph(source,[prepared],[source],[]);
 const configId=graph.configIds[0];
 const imageId=graph.nodes.find(node=>node.id===configId)!.metadata!.comfyWorkflowSelections!.video!.slots.opening.nodeId;
 expect(graph.connections).toEqual(expect.arrayContaining([
  expect.objectContaining({fromNodeId:imageId,fromPortId:"image",toNodeId:configId,toPortId:"opening"}),
  expect.objectContaining({fromNodeId:source.id,toNodeId:configId})
 ]));
 expect(graph.connections.find(e=>e.fromNodeId===source.id)?.fromPortId).toBeUndefined();
 const refreshed=refreshDramaVideoConfigGraph(source,prepared,configId,graph.nodes,graph.connections,{prompt:true,duration:false,references:true,overwrite:false});
 expect(refreshed.connections.find(e=>e.toNodeId===configId&&e.toPortId==="opening")?.fromPortId).toBe("image");
});
it("creates explicit first and last frame assignments for the normal video config entry point",()=>{
    const shot={id:"frames",episodeId:"ep",order:1,description:"Move",durationSec:5,
        characterVariantIds:[],propIds:[],keyPropIds:[]};
    const input=buildDramaVideoInput(snapshot,shot);
    const first="cas:"+"d".repeat(64),last="cas:"+"e".repeat(64);
    expect(()=>applyDramaProduction(input,{mode:"first_last_frame",firstFrame:first})).toThrow();
    const prepared=applyDramaProduction(input,{mode:"first_last_frame",firstFrame:first,lastFrame:last});
    const source=createCanvasNode("drama:storyboard",{x:0,y:0},{dramaConfirmedVersionId:"published"});
    const graph=buildDramaVideoConfigGraph(source,[prepared],[source],[]);
    const config=graph.nodes.find(node=>graph.configIds.includes(node.id))!;
    expect(config.metadata?.videoMode).toBe("first_last_frame");
    expect(config.metadata?.seconds).toBe("5");
    expect(config.metadata?.videoReferences?.map(reference=>reference.role)).toEqual(["first_frame","last_frame"]);
    expect(config.metadata?.videoReferences?.map(reference=>graph.nodes.find(node=>node.id===reference.id)?.metadata?.storageKey))
        .toEqual([first,last]);
    const edited={...config,metadata:{...config.metadata,prompt:"Human edit",composerContent:"Human edit",seconds:"7"}};
    const update={...prepared,prompt:"New direction",shot:{...shot,durationSec:8}};
    expect(()=>refreshDramaVideoConfig(edited,update,{prompt:true,duration:false,overwrite:false})).toThrow("人工修改");
    const refreshed=refreshDramaVideoConfig(edited,update,{prompt:true,duration:false,overwrite:true});
    expect(refreshed.prompt).toContain("New direction");
    expect(refreshed.seconds).toBe("7");
    expect(refreshed.videoReferences).toEqual(config.metadata?.videoReferences);
    expect(edited.metadata.prompt).toBe("Human edit");
    expect(applyDramaProduction(input,{mode:"text_to_video"}).referenceImages).toEqual([]);
    expect(()=>applyDramaProduction(input,{mode:"omni_reference",gridInput:true})).toThrow("网格图");
    const grid=applyDramaProduction(input,{mode:"omni_reference",gridInput:true,gridImage:first});
    expect(grid.mode).toBe("omni_reference");
    expect(grid.referenceImages.map(reference=>reference.storageKey)).toEqual([first]);
    expect(grid.prompt).toContain("从左到右");
});
const shot = { id: "shot-1", episodeId: "ep-1", order: 0, description: "主角在石桥举起星星", characterVariantIds: ["hero-day"], sceneId: "bridge", sceneVariantId: "bridge-rain", propIds: ["star"], keyPropIds: ["star"] };

describe("drama pipeline media inputs", () => {
    it("maps selected character, scene variant and key prop CAS images", () => {
        const input = buildDramaVideoInput(snapshot, shot);
        expect(input.prompt).toContain("石桥");
        expect(input.referenceImages.map(image => image.storageKey)).toEqual([
            "cas:" + "a".repeat(64), "cas:" + "b".repeat(64), "cas:" + "c".repeat(64),
        ]);
    });

    it("reports only required references without images", () => {
        const missing = structuredClone(snapshot);
        missing.references = missing.references.filter(reference => reference.assetId !== "star");
        expect(dramaVideoMissingReferenceIds(missing, shot)).toEqual(["star"]);
    });

    it("passes all selected images in order and deduplicates across asset slots", () => {
        const multi = structuredClone(snapshot);
        const first = "cas:" + "a".repeat(64);
        const second = "cas:" + "d".repeat(64);
        multi.references[0].imageStorageKeys = [first, second];
        multi.references[1].imageStorageKeys = [second, "cas:" + "b".repeat(64)];
        const images = buildDramaVideoInput(multi, shot).referenceImages;
        expect(images.map(image => image.storageKey)).toEqual([first, second, "cas:" + "b".repeat(64), "cas:" + "c".repeat(64)]);
        expect(new Set(images.map(image => image.id)).size).toBe(4);
        multi.references[0].imageStorageKeys = [];
        expect(dramaVideoMissingReferenceIds(multi, shot)).toEqual(["hero-day"]);
    });
});

it("creates editable video configs with real generation inputs and skips existing configs", () => {
    const source = createCanvasNode("drama:storyboard", { x:0, y:0 });
    const input = buildDramaVideoInput(snapshot, { ...shot, camera:"缓慢推近", dialogue:"看那边" });
    const plain = buildDramaVideoInput({ ...snapshot, references:[] }, { ...shot, id:"another" });
    const partial = buildDramaVideoInput({ ...snapshot, references:snapshot.references.slice(0, 1) }, { ...shot, id:"partial" });
    const graph = buildDramaVideoConfigGraph(source, [input, plain, partial], [source], [], "写实", "9:16");
    expect(graph.configIds).toHaveLength(3);
    const first = graph.nodes.find(node => node.id === graph.configIds[0])!;
    const second = graph.nodes.find(node => node.id === graph.configIds[1])!;
    expect(first.metadata).toMatchObject({ generationMode:"video", videoMode:"omni_reference", videoRatio:"9:16" });
    expect(second.metadata?.videoMode).toBe("text_to_video");
    const third = graph.nodes.find(node => node.id === graph.configIds[2])!;
    expect(third.metadata?.videoMode).toBe("omni_reference");
    expect(buildNodeGenerationContext(third.id, graph.nodes, graph.connections, third.metadata!.composerContent!).referenceImages).toHaveLength(1);
    const context = buildNodeGenerationContext(first.id, graph.nodes, graph.connections, first.metadata!.composerContent!);
    expect(context.referenceImages.map(image => image.storageKey)).toEqual(input.referenceImages.map(image => image.storageKey));
    expect(context.prompt).toContain("缓慢推近");
    expect(context.prompt).toContain("看那边");
    expect(context.prompt).toContain("写实");
    const edited = graph.nodes.map(node => node.id === first.id
        ? { ...node, metadata:{ ...node.metadata, composerContent:"用户修改" } } : node);
    const retry = buildDramaVideoConfigGraph(source, [input, plain, partial], edited, graph.connections);
    expect(retry.configIds).toEqual([]);
    expect(retry.nodes).toEqual(edited);
});


it("refreshes selected reference inputs while preserving media, other settings and manual edits",()=>{
    const source=createCanvasNode("drama:storyboard",{x:0,y:0},{dramaConfirmedVersionId:"revision-one"});
    const input=applyDramaProduction(buildDramaVideoInput(snapshot,shot),{mode:"first_frame",firstFrame:"cas:"+"d".repeat(64)});
    const initial=buildDramaVideoConfigGraph(source,[input],[source],[],"Ink");
    const config=initial.nodes.find(node=>initial.configIds.includes(node.id))!;
    config.metadata!.videoRatio="16:9";
    const replacement=applyDramaProduction(input,{mode:"first_last_frame",firstFrame:"cas:"+"e".repeat(64),lastFrame:"cas:"+"f".repeat(64)});
    const fields={prompt:true,duration:false,references:true,overwrite:false};
    const updated=refreshDramaVideoConfigGraph(source,replacement,config.id,initial.nodes,initial.connections,fields,"Ink");
    const result=updated.nodes.find(node=>node.id===config.id)!;
    expect(result.metadata?.videoReferences?.map(ref=>ref.role)).toEqual(["first_frame","last_frame"]);
    expect(result.metadata?.videoRatio).toBe("16:9");
    const styled=refreshDramaVideoConfigGraph(source,replacement,config.id,updated.nodes,updated.connections,
        {...fields,references:false},"Watercolor").nodes.find(node=>node.id===config.id)!;
    expect(styled.metadata?.prompt).toContain("影片风格：Watercolor");
    expect(styled.metadata?.prompt).not.toContain("影片风格：Ink");
    expect(styled.metadata?.videoReferences).toEqual(result.metadata?.videoReferences);
    expect(styled.metadata?.dramaVideoSource?.visualStyle).toBe("Watercolor");
    expect(initial.nodes.every(node=>updated.nodes.some(next=>next.id===node.id))).toBe(true);
    expect(updated.connections.filter(edge=>edge.toNodeId===config.id)).toHaveLength(3);
    expect(result.metadata?.prompt).not.toContain(input.referenceImages[0].id);
    expect(()=>refreshDramaVideoConfigGraph(source,input,config.id,updated.nodes,updated.connections,fields,"Ink")).not.toThrow();
    const manualEdges=[...initial.connections,{id:"manual",fromNodeId:"human-input",toNodeId:config.id}];
    expect(()=>refreshDramaVideoConfigGraph(source,replacement,config.id,initial.nodes,manualEdges,fields)).toThrow("人工修改");
    expect(()=>refreshDramaVideoConfigGraph(source,replacement,config.id,initial.nodes,manualEdges,{...fields,overwrite:true})).not.toThrow();
});
