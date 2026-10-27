import {afterEach,describe,expect,it,vi} from "vitest";
vi.mock("@/lib/zip",()=>({readZip:vi.fn(),createZip:vi.fn()}));
vi.mock("@/features/backend-sync/canvas-media",()=>({
 uploadCanvasImage:vi.fn(),uploadCanvasMedia:vi.fn()
}));
vi.mock("@/services/image-storage",()=>({setImageBlob:vi.fn(),getImageBlob:vi.fn()}));
vi.mock("@/services/file-storage",()=>({setMediaBlob:vi.fn(),getMediaBlob:vi.fn()}));
vi.mock("file-saver",()=>({saveAs:vi.fn()}));

import {readZip} from "@/lib/zip";
import {uploadCanvasImage} from "@/features/backend-sync/canvas-media";
import {setImageBlob} from "@/services/image-storage";
import {readAssetPackage} from "./asset-transfer";

const sha="a".repeat(64),storageKey="cas:"+sha;
const asset={id:"photo",kind:"image",title:"a",coverUrl:"/api/v1/blobs/"+sha,tags:[],
 createdAt:"2026-01-01",updatedAt:"2026-01-01",
 data:{storageKey,dataUrl:"/api/v1/blobs/"+sha,bytes:4,mimeType:"image/png",width:1,height:1}};
const archive=(assetFiles:Array<{storageKey:string;path:string;mimeType:string;bytes:number}>)=>
 new Map<string,Blob>([
 ["assets.json",new Blob([JSON.stringify({app:"infinite-canvas",version:1,assets:[asset],files:assetFiles})])],
 ["files/hashed.png",new Blob(["data"],{type:"image/png"})]
 ]);
afterEach(()=>vi.clearAllMocks());
describe("P5.4 portable library ZIP imports",()=>{
 it("reuploads CAS media and validates returned digest without writing IndexedDB",async()=>{
  vi.mocked(readZip).mockResolvedValue(archive([{storageKey,path:"files/hashed.png",mimeType:"image/png",bytes:4}]));
  vi.mocked(uploadCanvasImage).mockResolvedValue({
   storageKey,url:"/api/v1/blobs/"+sha,bytes:4,mimeType:"image/png",width:1,height:1
  });
  expect(await readAssetPackage(new File([],"assets.zip"))).toHaveLength(1);
  expect(uploadCanvasImage).toHaveBeenCalledOnce();
  expect(setImageBlob).not.toHaveBeenCalled();
 });
 it("rejects missing media files and hash mismatch without pretending restore succeeded",async()=>{
  vi.mocked(readZip).mockResolvedValue(archive([{storageKey,path:"files/nope.png",mimeType:"image/png",bytes:4}]));
  await expect(readAssetPackage(new File([],"assets.zip"))).rejects.toThrow("asset_package_media_missing");
  vi.mocked(readZip).mockResolvedValue(archive([{storageKey,path:"files/hashed.png",mimeType:"image/png",bytes:4}]));
  vi.mocked(uploadCanvasImage).mockResolvedValue({
   storageKey:"cas:"+"b".repeat(64),url:"/api/v1/blobs/"+"b".repeat(64),bytes:4,mimeType:"image/png",width:1,height:1
  });
  await expect(readAssetPackage(new File([],"assets.zip"))).rejects.toThrow("asset_package_cas_mismatch");
 });
 it("imports old browser image keys directly as CAS and never recreates old IndexedDB blobs",async()=>{
  const oldKey="image:old";
  const oldAsset={...asset,coverUrl:"blob:old-cover",data:{...asset.data,storageKey:oldKey,dataUrl:"blob:old"}};
  const zip=archive([{storageKey:oldKey,path:"files/hashed.png",mimeType:"image/png",bytes:4}]);
  zip.set("assets.json",new Blob([JSON.stringify({app:"infinite-canvas",version:1,assets:[oldAsset],files:[{storageKey:oldKey,path:"files/hashed.png",mimeType:"image/png",bytes:4}]})]));
  vi.mocked(readZip).mockResolvedValue(zip);
  vi.mocked(uploadCanvasImage).mockResolvedValue({
   storageKey,url:"/api/v1/blobs/"+sha,bytes:4,mimeType:"image/png",width:1,height:1
  });
  const items=await readAssetPackage(new File([],"legacy.zip"));
  expect(items).toHaveLength(1);
  expect(items[0].coverUrl).toBe("/api/v1/blobs/"+sha);
  expect(items[0].kind).toBe("image");
  if(items[0].kind==="image"){
   expect(items[0].data.storageKey).toBe(storageKey);
   expect(items[0].data.dataUrl).toBe("/api/v1/blobs/"+sha);
  }
  expect(setImageBlob).not.toHaveBeenCalled();
 });
 it("rejects a second missing or incorrectly sized file before publishing the first valid CAS",async()=>{
  vi.mocked(readZip).mockResolvedValue(archive([{storageKey,path:"files/hashed.png",mimeType:"image/png",bytes:20}]));
  await expect(readAssetPackage(new File([],"bad.zip"))).rejects.toThrow("asset_package_media_missing");
  expect(uploadCanvasImage).not.toHaveBeenCalled();
 });
});
