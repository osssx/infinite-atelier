// @vitest-environment happy-dom
import {describe,it,expect} from "vitest";
import {createCanvasNode} from "@/lib/canvas/canvas-node-factory";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";
import {resolveDramaShotGroupConfigs} from "./drama-shot-group-plan";
import type {DramaShot} from "./canvas-drama-pipeline";

const shot=(id:string,order:number):DramaShot=>({id,episodeId:"ep-1",order,
    description:"Shot "+id,characterVariantIds:[],propIds:[],keyPropIds:[]});
const shots=[shot("shot-1",10),shot("shot-2",20),shot("shot-3",30)];
const config=(id:string):CanvasNodeData=>createCanvasNode(CanvasNodeType.Config,
    {x:0,y:0},{dramaShotId:id,generationMode:"video"});
const ids=()=>new Map(shots.map(shot=>[shot.id,config(shot.id)]));
describe("P3.2 explicit selection to existing Comfy Shot Group",()=>{
    it("orders only chosen confirmed shots and never creates or submits a media job",()=>{
        const map=ids();
        const result=resolveDramaShotGroupConfigs(shots,["shot-3","shot-1"],map);
        expect(result).toEqual([map.get("shot-1")!.id,map.get("shot-3")!.id]);
        expect(map.get("shot-1")!.metadata?.videoReferences).toBeUndefined();
        expect(map.size).toBe(3);
    });
    it("fails closed on missing/duplicate/old/unconfirmed Configs",()=>{
        const map=ids();
        expect(()=>resolveDramaShotGroupConfigs(shots,["shot-1"],map)).toThrow("2–128");
        expect(()=>resolveDramaShotGroupConfigs(shots,["shot-1","shot-1"],map)).toThrow("重复");
        expect(()=>resolveDramaShotGroupConfigs(shots,["shot-1","unknown"],map)).toThrow("移除");
        map.delete("shot-2");
        expect(()=>resolveDramaShotGroupConfigs(shots,["shot-1","shot-2"],map)).toThrow("视频 Config");
        map.set("shot-2",createCanvasNode(CanvasNodeType.Config,{x:0,y:0},{generationMode:"image",dramaShotId:"shot-2"}));
        expect(()=>resolveDramaShotGroupConfigs(shots,["shot-1","shot-2"],map)).toThrow("视频 Config");
    });
    it("rejects a Config already grouped elsewhere or reused by two shots",()=>{
        const map=ids();
        map.get("shot-2")!.metadata!.groupId="other-group";
        expect(()=>resolveDramaShotGroupConfigs(shots,["shot-1","shot-2"],map)).toThrow("其他镜头组");
        map.get("shot-2")!.metadata!.groupId=undefined;
        const reused=map.get("shot-1")!;
        map.set("shot-2",{...reused,metadata:{...reused.metadata,dramaShotId:"shot-2"}});
        expect(()=>resolveDramaShotGroupConfigs(shots,["shot-1","shot-2"],map)).toThrow("同一个视频 Config");
    });
});
