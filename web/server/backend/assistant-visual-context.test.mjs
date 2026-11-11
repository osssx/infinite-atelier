import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {resolveAssistantVisualContext} from "./assistant-visual-context.mjs";

const png=Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]);
const id=createHash("sha256").update(png).digest("hex");
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),"assistant-visual-"));
 const path=join(dir,"picture.png");writeFileSync(path,png);
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const blobStore={stat:async blobId=>{
  if(blobId!==id)throw Object.assign(Error("not found"),{code:"blob_not_found",statusCode:404});
  return {id,sha256:id,byteSize:png.length,mimeType:"image/png",path};
 }};
 const image={id:"a",type:"image",metadata:{storageKey:"cas:"+id}};
 return {blobStore,image,dir,path};
}
test("resolves server-owned CAS original from node identity without accepting client URLs",async t=>{
 const f=fixture(t);
 const result=await resolveAssistantVisualContext({document:{nodes:[f.image]},
  blobStore:f.blobStore,visualContext:{images:[{nodeId:"a"}],detail:"high"}});
 assert.deepEqual(result.images,[{bytes:png,mimeType:"image/png"}]);
 assert.deepEqual(result.references,[{nodeId:"a",blobId:id}]);
 assert.deepEqual(await resolveAssistantVisualContext({document:{nodes:[f.image]},blobStore:f.blobStore}),{images:[],references:[]});
});
test("rejects unavailable, ambiguous, not-persisted and tampered canvas image refs",async t=>{
 const f=fixture(t);
 const wrong={id:"not-img",type:"text",metadata:{storageKey:"cas:"+id}};
 const multi={id:"batch",type:"image",metadata:{images:[
  {id:"i1",storageKey:"cas:"+id},
  {id:"i2",storageKey:"cas:"+id}
 ]}};
 const cases=[
  [{nodes:[f.image]},{images:[{nodeId:"cross-project"}]},"assistant_visual_node_unavailable"],
  [{nodes:[wrong]},{images:[{nodeId:"not-img"}]},"assistant_visual_node_unavailable"],
  [{nodes:[multi]},{images:[{nodeId:"batch"}]},"assistant_visual_image_ambiguous"],
  [{nodes:[multi]},{images:[{nodeId:"batch",imageId:"absent"}]},"assistant_visual_node_unavailable"],
  [{nodes:[{...f.image,metadata:{content:"https://evil.example/p.png"}}]},{images:[{nodeId:"a"}]},"assistant_visual_not_materialized"],
  [{nodes:[f.image]},{images:[{nodeId:"a",url:"https://evil.example"}]},"assistant_visual_invalid"],
  [{nodes:[f.image]}, {images:[{nodeId:"a"},{nodeId:"a"},{nodeId:"a"},{nodeId:"a"},{nodeId:"a"}]},"assistant_visual_invalid"]
 ];
 for(const [document,visualContext,code] of cases)
  await assert.rejects(resolveAssistantVisualContext({document,blobStore:f.blobStore,visualContext}),{code});
 const selected=await resolveAssistantVisualContext({document:{nodes:[multi]},
  blobStore:f.blobStore,visualContext:{images:[{nodeId:"batch",imageId:"i2"}]}});
 assert.equal(selected.references[0].imageId,"i2");
 const primary=await resolveAssistantVisualContext({document:{nodes:[{
  ...multi,metadata:{...multi.metadata,primaryImageId:"i2"}
 }]},blobStore:f.blobStore,visualContext:{images:[{nodeId:"batch"}]}});
 assert.equal(primary.references[0].imageId,"i2");
 writeFileSync(f.path,"tampered");
 await assert.rejects(resolveAssistantVisualContext({document:{nodes:[f.image]},
  blobStore:f.blobStore,visualContext:{images:[{nodeId:"a"}]}}),{code:"assistant_visual_image_integrity"});
});
test("validates type and quotas before reading image payload",async t=>{
 const f=fixture(t);
 const large={stat:async()=>({...await f.blobStore.stat(id),byteSize:30*1024*1024})};
 await assert.rejects(resolveAssistantVisualContext({document:{nodes:[f.image]},
  blobStore:large,visualContext:{images:[{nodeId:"a"}]}}),{code:"assistant_visual_image_invalid"});
 const svg={stat:async()=>({...await f.blobStore.stat(id),mimeType:"image/svg+xml"})};
 await assert.rejects(resolveAssistantVisualContext({document:{nodes:[f.image]},
  blobStore:svg,visualContext:{images:[{nodeId:"a"}]}}),{code:"assistant_visual_image_invalid"});
});
