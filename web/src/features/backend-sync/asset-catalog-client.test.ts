import {afterEach,describe,expect,it,vi} from "vitest";

vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn()}));
vi.mock("@/features/backend-sync/canvas-media",()=>({
 uploadCanvasImage:vi.fn(),uploadCanvasMedia:vi.fn()
}));
vi.mock("@/services/image-storage",()=>({getImageBlob:vi.fn()}));
vi.mock("@/services/file-storage",()=>({getMediaBlob:vi.fn()}));

import {canvasApi} from "@/features/backend-sync/canvas-api";
import {uploadCanvasImage} from "@/features/backend-sync/canvas-media";
import {getImageBlob} from "@/services/image-storage";
import {normalizeAssetCatalogItem,normalizeAssetCatalog,readBackendAssetCatalog,saveBackendAssetCatalog} from "./asset-catalog-client";
import type {Asset} from "@/stores/use-asset-store";

const sha="a".repeat(64),url="/api/v1/blobs/"+sha;
const image:Asset={id:"test",kind:"image",title:"A",coverUrl:"blob:stale",tags:[],
 createdAt:"2026-01-01",updatedAt:"2026-01-02",
 data:{storageKey:"image:old",dataUrl:"blob:stale",width:100,height:80,bytes:16,mimeType:"image/png"}};
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals()});
describe("P5.4 SQLite asset catalog client",()=>{
 it("does not auto read old browser storage; GET/PUT use SQLite API",async()=>{
  vi.mocked(canvasApi).mockResolvedValue({revision:1,assets:[]});
  expect(await readBackendAssetCatalog()).toEqual({revision:1,assets:[]});
  await saveBackendAssetCatalog(1,[]);
  expect(canvasApi).toHaveBeenCalledWith("/api/v1/assets");
  expect(canvasApi).toHaveBeenCalledWith("/api/v1/assets","PUT",{expectedRevision:1,assets:[]});
 });
 it("explicitly upgrades a legacy image Blob to backend CAS before writing any metadata",async()=>{
  const blob=new Blob(["png"],{type:"image/png"});
  vi.mocked(getImageBlob).mockResolvedValue(blob);
  vi.mocked(uploadCanvasImage).mockResolvedValue({url,storageKey:"cas:"+sha,width:100,height:80,bytes:3,mimeType:"image/png"});
  const converted=await normalizeAssetCatalogItem(image);
  expect(converted.kind).toBe("image");
  if(converted.kind!=="image")throw Error("invalid");
  expect(converted.data.storageKey).toBe("cas:"+sha);
  expect(converted.data.dataUrl).toBe(url);
  expect(converted.data.bytes).toBe(3);
  expect(converted.coverUrl).toBe(url);
  expect(getImageBlob).toHaveBeenCalledWith("image:old");
  expect(canvasApi).not.toHaveBeenCalled();
 });
 it("verifies already-CAS metadata with HEAD without downloading the video body",async()=>{
  const key="cas:"+sha;
  const source:Asset={...image,coverUrl:"",data:{...image.data,storageKey:key,dataUrl:url,bytes:800}};
  const fetchMock=vi.fn().mockResolvedValue({ok:true,headers:new Headers({"content-type":"image/png","content-length":"900"})});
  vi.stubGlobal("fetch",fetchMock);
  const converted=await normalizeAssetCatalogItem(source);
  if(converted.kind!=="image")throw Error("invalid");
  expect(converted.data.bytes).toBe(900);
  expect(fetchMock).toHaveBeenCalledWith(url,{method:"HEAD",credentials:"same-origin",cache:"no-store"});
  expect(uploadCanvasImage).not.toHaveBeenCalled();
 });
 it("fails closed on missing legacy binary; no partial metadata write",async()=>{
  vi.mocked(getImageBlob).mockResolvedValue(null);
  await expect(normalizeAssetCatalog([image])).rejects.toThrow("asset_legacy_media_missing");
  expect(canvasApi).not.toHaveBeenCalled();
 });
});
