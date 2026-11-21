import {describe,it,expect} from "vitest";
import {mergeAssetCandidates,suggestAssetMatches} from "./drama-asset-merge";
import type {DramaAsset} from "./canvas-drama-pipeline";

describe("asset candidate review",()=>{
    const existing:DramaAsset={id:"hero",kind:"character",name:"主角",description:"Original",
        sourceRefs:["p1"],variants:[{id:"coat",name:"外套",description:"Original coat"}]};
    const candidate:DramaAsset={id:"generated",kind:"character",name:"主角",description:"New outfit",sourceRefs:["p2"]};
    it("suggests same-type matches and preserves identity, description and media slot IDs on reuse",()=>{
        expect(suggestAssetMatches(candidate,[existing,{...existing,id:"prop",kind:"prop"}])).toEqual([existing]);
        expect(suggestAssetMatches({...candidate,name:"别称"},[{...existing,aliases:["别称"]}])).toHaveLength(1);
        const result=mergeAssetCandidates([existing],[candidate],{generated:{action:"reuse",targetId:"hero"}});
        expect(result[0]).toEqual({...existing,sourceRefs:["p1","p2"]});
        expect(existing.sourceRefs).toEqual(["p1"]);
    });
    it("adds a variant without replacing existing costumes and assigns fresh IDs to new entities",()=>{
        const variants=mergeAssetCandidates([existing],[candidate],{generated:{action:"variant",targetId:"hero"}});
        expect(variants[0].variants?.[0].id).toBe("coat");
        expect(variants[0].variants?.[1].description).toBe("New outfit");
        const added=mergeAssetCandidates([existing],[candidate],{generated:{action:"new"}});
        expect(added).toHaveLength(2);
        expect(added[1].id).not.toBe(candidate.id);
        expect(mergeAssetCandidates([existing],[candidate],{})).toHaveLength(1);
    });
});
