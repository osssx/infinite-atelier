import {beforeEach,expect,it,vi} from "vitest";
import type {DramaAsset} from "./canvas-drama-pipeline";
const evidence=vi.hoisted(()=>({api:vi.fn(),barrier:vi.fn(),hydrate:vi.fn(),assert:vi.fn()}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:evidence.api}));
vi.mock("@/stores/canvas/use-canvas-sqlite-store",()=>({commitAssistantCanvasGraphWithSaveBarrier:evidence.barrier,ensureCreativeNodesLoaded:evidence.hydrate}));
import {saveAssetEntry} from "./drama-asset-entry-save";
const base:DramaAsset={id:"a1",kind:"character",name:"主角",description:"原描述",sourceRefs:["p1"],variants:[{id:"v1",name:"默认",description:"造型描述"}]};
const digest="a".repeat(64);
beforeEach(()=>{
 vi.resetAllMocks();
 evidence.barrier.mockImplementation(async(_p,submit)=>submit({assertCurrent:evidence.assert}));
 evidence.api.mockResolvedValueOnce({entries:[{...base}],entryDigests:[{id:"a1",digest}]}).mockResolvedValueOnce({revision:2});
});
it("reads matching complete entry inside save barrier then patches with server digest and reloads only edited node",async()=>{
 await saveAssetEntry("p","node",base,{description:"新描述"},"v1");
 expect(evidence.api.mock.calls[0][0]).toContain("draft=true&entryId=a1&limit=1");
 expect(evidence.api.mock.calls[1]).toEqual([expect.stringContaining("/entry-draft"),"PATCH",{
  nodeId:"node",kind:"assets",entryId:"a1",expectedDigest:digest,operationId:expect.any(String),changes:{description:"新描述"},variantId:"v1"
 }]);
 expect(evidence.assert).toHaveBeenCalledOnce();
 expect(evidence.barrier.mock.calls[0][2]).toEqual({keepCreativePointers:true,invalidateCreativeNodeId:"node"});
 expect(evidence.hydrate).toHaveBeenCalledWith("p",["node"]);
});
it("rejects stale complete entry, even when the edited field is unchanged remotely",async()=>{
 evidence.api.mockReset().mockResolvedValue({entries:[{...base,aliases:["外部修改"]}],entryDigests:[{id:"a1",digest}]});
 await expect(saveAssetEntry("p","node",base,{name:"新名称"})).rejects.toThrow("drama_candidate_conflict");
 expect(evidence.api).toHaveBeenCalledOnce();expect(evidence.hydrate).not.toHaveBeenCalled();
});
it("does not send a patch when local graph becomes dirty after reading",async()=>{
 evidence.assert.mockImplementation(()=>{throw Error("project_unsaved_local_edits")});
 await expect(saveAssetEntry("p","node",base,{name:"新名称"})).rejects.toThrow("project_unsaved_local_edits");
 expect(evidence.api).toHaveBeenCalledOnce();
});
it("keeps remote CAS rejection visible without retrying or writing full draft",async()=>{
 evidence.api.mockReset().mockResolvedValueOnce({entries:[base],entryDigests:[{id:"a1",digest}]}).mockRejectedValueOnce(Error("drama_candidate_conflict"));
 await expect(saveAssetEntry("p","node",base,{name:"新名称"})).rejects.toThrow("drama_candidate_conflict");
 expect(evidence.api).toHaveBeenCalledTimes(2);expect(evidence.hydrate).not.toHaveBeenCalled();
});
