import {beforeEach,describe,expect,it,vi} from "vitest";

vi.mock("@/features/backend-sync/asset-catalog-client",()=>({
 readBackendAssetCatalog:vi.fn(), saveBackendAssetCatalog:vi.fn(),
 normalizeAssetCatalog:vi.fn(async (items:unknown)=>items)
}));
import {readBackendAssetCatalog,saveBackendAssetCatalog,normalizeAssetCatalog} from "@/features/backend-sync/asset-catalog-client";

const note={id:"note_1",kind:"text",title:"Keep",coverUrl:"",tags:[],
 createdAt:"2026-10-27",updatedAt:"2026-10-27",data:{content:"Hello"}};
beforeEach(()=>{
 vi.resetModules();
 vi.mocked(readBackendAssetCatalog).mockReset();
 vi.mocked(saveBackendAssetCatalog).mockReset();
 vi.mocked(normalizeAssetCatalog).mockReset().mockImplementation(async x=>x);
});

async function start(assets:unknown[]=[]){
 vi.mocked(readBackendAssetCatalog).mockResolvedValue({revision:3,assets} as never);
 vi.mocked(saveBackendAssetCatalog).mockImplementation(async (revision:number,items:unknown)=>
  ({revision:revision+1,assets:items}) as never);
 const mod=await import("./use-asset-store");
 await vi.waitFor(()=>expect(mod.useAssetStore.getState().hydrated).toBe(true));
 await mod.awaitAssetStorePersistence();
 return mod;
}
describe("P5.4 asset library SQLite-only durability",()=>{
 it("hydrates only from the authoritative backend SQLite asset catalog",async()=>{
  const mod=await start([note]);
  expect(mod.useAssetStore.getState().assets).toEqual([note]);
  expect(readBackendAssetCatalog).toHaveBeenCalledOnce();
 });
 it("ordered writes use expectedRevision and never persist browser snapshots",async()=>{
  const mod=await start();
  mod.useAssetStore.getState().addAsset({kind:"text",title:"New",coverUrl:"",tags:[],data:{content:"hello"}});
  await mod.awaitAssetStorePersistence();
  expect(saveBackendAssetCatalog).toHaveBeenCalledOnce();
  expect(vi.mocked(saveBackendAssetCatalog).mock.calls[0][0]).toBe(3);
 });
 it("after an uncertain/409 write, the next mutation cannot blindly overwrite",async()=>{
  const mod=await start();
  vi.mocked(saveBackendAssetCatalog).mockRejectedValueOnce(Error("asset_catalog_revision_conflict"));
  mod.useAssetStore.getState().addAsset({kind:"text",title:"A",coverUrl:"",tags:[],data:{content:"a"}});
  await expect(mod.awaitAssetStorePersistence()).rejects.toThrow("asset_catalog_revision_conflict");
  mod.useAssetStore.getState().addAsset({kind:"text",title:"B",coverUrl:"",tags:[],data:{content:"b"}});
  await expect(mod.awaitAssetStorePersistence()).rejects.toThrow("asset_catalog_reload_required");
  expect(saveBackendAssetCatalog).toHaveBeenCalledOnce();
 });
});
