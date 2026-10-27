import {beforeEach,describe,expect,it,vi} from "vitest";

vi.mock("@/features/backend-sync/asset-catalog-client",()=>({
 readBackendAssetCatalog:vi.fn(), saveBackendAssetCatalog:vi.fn(),
 normalizeAssetCatalog:vi.fn(async (items:unknown)=>items)
}));
vi.mock("@/lib/localforage-storage",()=>({
 localForageStorage:{getItem:vi.fn(),setItem:vi.fn(),removeItem:vi.fn()}
}));
import {readBackendAssetCatalog,saveBackendAssetCatalog,normalizeAssetCatalog} from "@/features/backend-sync/asset-catalog-client";
import {localForageStorage} from "@/lib/localforage-storage";

const note={id:"note_1",kind:"text",title:"Keep",coverUrl:"",tags:[],
 createdAt:"2026-10-27",updatedAt:"2026-10-27",data:{content:"Hello"}};
beforeEach(()=>{
 vi.resetModules();
 vi.mocked(readBackendAssetCatalog).mockReset();
 vi.mocked(saveBackendAssetCatalog).mockReset();
 vi.mocked(normalizeAssetCatalog).mockReset().mockImplementation(async x=>x);
 vi.mocked(localForageStorage.getItem).mockReset();
 vi.mocked(localForageStorage.setItem).mockReset();
 vi.mocked(localForageStorage.removeItem).mockReset();
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
 it("hydrates only from backend: never reads browser LocalForage automatically",async()=>{
  const mod=await start([note]);
  expect(mod.useAssetStore.getState().assets).toEqual([note]);
  expect(readBackendAssetCatalog).toHaveBeenCalledOnce();
  expect(localForageStorage.getItem).not.toHaveBeenCalled();
  expect(localForageStorage.setItem).not.toHaveBeenCalled();
 });
 it("ordered writes use expectedRevision and never persist browser snapshots",async()=>{
  const mod=await start();
  mod.useAssetStore.getState().addAsset({kind:"text",title:"New",coverUrl:"",tags:[],data:{content:"hello"}});
  await mod.awaitAssetStorePersistence();
  expect(saveBackendAssetCatalog).toHaveBeenCalledOnce();
  expect(vi.mocked(saveBackendAssetCatalog).mock.calls[0][0]).toBe(3);
  expect(localForageStorage.setItem).not.toHaveBeenCalled();
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
 it("explicit legacy import requires empty backend, preserves old browser state",async()=>{
  const nonEmpty=await start([note]);
  await expect(nonEmpty.importLegacyBrowserAssets()).rejects.toThrow("asset_catalog_not_empty");
  expect(localForageStorage.getItem).not.toHaveBeenCalled();
 });
 it("explicit import into empty backend persists once and never deletes old keys",async()=>{
  const mod=await start();
  vi.mocked(localForageStorage.getItem).mockResolvedValue(JSON.stringify({state:{assets:[note]}}));
  await expect(mod.importLegacyBrowserAssets()).resolves.toBe(1);
  expect(saveBackendAssetCatalog).toHaveBeenCalledWith(3,[note]);
  expect(localForageStorage.removeItem).not.toHaveBeenCalled();
 });
});
