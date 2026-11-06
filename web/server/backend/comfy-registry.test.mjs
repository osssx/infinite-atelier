import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {initializeSchema,SCHEMA_VERSION} from "./schema.mjs";
import {buildApp} from "./app.mjs";
import {createProject} from "./projects.mjs";
import {validateComfyTemplate} from "./comfy-registry.mjs";
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==="object"?
 Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
function template(seed=1,id="workflow:test"){
 const apiGraph={"1":{class_type:"Image",inputs:{seed}}};
 const ports=[{id:"result",label:"Result",direction:"source",valueKind:"IMAGE",
  outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"none"}}];
 const payload={name:"Test workflow",apiGraph,ports,requirements:{classTypes:["Image"]}};
 return {id,revision:createHash("sha256").update(JSON.stringify(sort(payload))).digest("hex"),...payload};
}
function fixture(t){
 const db=new DatabaseSync(":memory:");initializeSchema(db);
 const app=buildApp({db,authorize:req=>req.headers["x-test-owner"]==="owner"});
 t.after(async()=>{await app.close();db.close()});
 const call=(method,url,payload,headers)=>app.inject({method,url,headers:{"x-test-owner":"owner",...headers},
  ...(payload===undefined?{}:{payload})});
 return {db,app,call};
}
test("P4.5 templates immutable, presets point to versions, protect referenced deletes",async t=>{
 const {db,call,app}=fixture(t),base="/api/v1/comfy/templates";
 const old=template(1),next=template(2);
 assert.equal((await app.inject({method:"GET",url:base})).statusCode,401);
 assert.equal((await call("POST",base,{template:old},{origin:"http://evil.example"})).statusCode,403);
 assert.equal((await call("POST",base,{template:old})).statusCode,201);
 assert.equal((await call("POST",base,{template:old})).json().status,"existing");
 assert.equal((await call("GET",base)).json().templates.length,1);
 assert.deepEqual((await call("GET",base+"/"+encodeURIComponent(old.id)+"/"+old.revision)).json().template,old);
 const bad=structuredClone(old);bad.apiGraph["1"].inputs.seed=4;
 assert.equal((await call("POST",base,{template:bad})).statusCode,409);
 assert.equal((await call("POST",base,{template:next})).statusCode,201);
 const preset={id:"custom",name:"Preset",templateId:old.id,revision:old.revision};
 assert.equal((await call("PUT","/api/v1/comfy/presets/custom",preset)).statusCode,200);
 assert.deepEqual((await call("GET","/api/v1/comfy/presets")).json().presets,[preset]);
 assert.equal((await call("DELETE",base+"/"+encodeURIComponent(old.id)+"/"+old.revision)).statusCode,409);
 const updated={...preset,revision:next.revision};
 assert.equal((await call("PUT","/api/v1/comfy/presets/custom",updated)).statusCode,200);
 createProject(db,{id:"canvas",document:{title:"Hello",nodes:[{id:"w",type:"comfy:workflow",
  metadata:{comfyWorkflow:{templateId:old.id,templateRevision:old.revision}}}],connections:[]}});
 assert.equal((await call("DELETE",base+"/"+encodeURIComponent(old.id)+"/"+old.revision)).statusCode,409);
 assert.equal((await call("DELETE","/api/v1/comfy/presets/custom")).statusCode,200);
 assert.equal((await call("GET",base+"/"+encodeURIComponent(next.id)+"/"+next.revision)).statusCode,200);
 assert.equal((await call("GET",base+"/absent/"+"a".repeat(64))).statusCode,404);
});
test("SQLite template registry hashes and retains optional KJ preview bindings",async t=>{
 const {call}=fixture(t),graph={"1":{class_type:"Image",inputs:{seed:1}},
  "2":{class_type:"ModelPreviewOverrideKJ",inputs:{model:["1",0],max_resolution:512,jpeg_quality:80,suppress_default_preview:true,preview_frames:1,preview_fps:8}}};
 const baseTemplate=template(1,"workflow:preview"),payload={...baseTemplate,apiGraph:graph,
  requirements:{classTypes:["Image","ModelPreviewOverrideKJ"]},previewBinding:{protocol:"kj-preview",nodeId:"2"}};
 payload.revision=createHash("sha256").update(JSON.stringify(sort({name:payload.name,apiGraph:payload.apiGraph,ports:payload.ports,
  requirements:payload.requirements,previewBinding:payload.previewBinding}))).digest("hex");
 assert.equal((await call("POST","/api/v1/comfy/templates",{template:payload})).statusCode,201);
 assert.deepEqual((await call("GET",`/api/v1/comfy/templates/${encodeURIComponent(payload.id)}/${payload.revision}`)).json().template.previewBinding,payload.previewBinding);
 const invalid={...payload,id:"workflow:bad",previewBinding:{protocol:"kj-preview",nodeId:"1"}};
 invalid.revision=createHash("sha256").update(JSON.stringify(sort({name:invalid.name,apiGraph:invalid.apiGraph,ports:invalid.ports,
  requirements:invalid.requirements,previewBinding:invalid.previewBinding}))).digest("hex");
 assert.equal((await call("POST","/api/v1/comfy/templates",{template:invalid})).statusCode,400);
});
test("template registry rejects legacy media setting mappings without migrating or stripping them",async t=>{
 const {call}=fixture(t),legacy=template();
 legacy.mediaUseCase={channel:"image",primaryOutputKind:"image",promptPortId:"prompt",slots:[],primaryOutputPortId:"result",settings:{imageQuality:"quality"}};
 const payload={name:legacy.name,apiGraph:legacy.apiGraph,ports:legacy.ports,requirements:legacy.requirements,mediaUseCase:legacy.mediaUseCase};
 legacy.revision=createHash("sha256").update(JSON.stringify(sort(payload))).digest("hex");
 assert.throws(()=>validateComfyTemplate(legacy),error=>error.code==="comfy_template_media_use_case_invalid");
 const response=await call("POST","/api/v1/comfy/templates",{template:legacy});
 assert.equal(response.statusCode,400);
 assert.equal(response.json().code,"invalid_request");
});
test("P4.5 template batch install atomic rollback, schema v8 migration",async t=>{
 const {db,call}=fixture(t),base="/api/v1/comfy/templates/batch";
 const a=template(1,"a"),b=template(2,"b"),corrupt=structuredClone(b);
 corrupt.name="tampered";
 const rejected=await call("POST",base,{templates:[a,corrupt]});
 assert.equal(rejected.statusCode,409,rejected.body);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comfy_template_versions").get().n,0);
 const accepted=await call("POST",base,{templates:[a,b]});
 assert.equal(accepted.statusCode,200);
 assert.deepEqual(accepted.json().results.map(x=>x.status),["installed","installed"]);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comfy_template_versions").get().n,2);
 const older=new DatabaseSync(":memory:");
 t.after(()=>older.close());
 initializeSchema(older);
 older.prepare("DELETE FROM schema_migrations WHERE version>8").run();
 older.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(8,1)").run();
 older.exec("DROP TABLE comfy_presets;DROP TABLE comfy_template_versions");
 initializeSchema(older);
 assert.equal(older.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,SCHEMA_VERSION);
 assert.ok(older.prepare("SELECT name FROM sqlite_master WHERE name='comfy_presets'").get());
});
