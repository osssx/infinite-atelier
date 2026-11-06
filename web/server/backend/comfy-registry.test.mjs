import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,readFileSync,rmSync,existsSync,writeFileSync,unlinkSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
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

test("v22 upgrade preserves existing versions, notes survive reopen and repeated installs retain timestamps",async t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const {createComfyRegistry}=await import("./comfy-registry.mjs");
 const registry=createComfyRegistry(db),original=template(7,"upgrade");registry.installMany([original]);
 db.exec("DROP TABLE comfy_template_version_notes; DELETE FROM schema_migrations WHERE version>22; INSERT OR IGNORE INTO schema_migrations VALUES(22,1)");
 initializeSchema(db);assert.equal(db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v,23);
 assert.deepEqual(registry.getVersionNote(original.id,original.revision),{note:""});
 registry.setVersionNote(original.id,original.revision,"保留配置");
 const before=db.prepare("SELECT created_at FROM comfy_workflow_versions").get().created_at;
 registry.installMany([original]);
 assert.equal(db.prepare("SELECT created_at FROM comfy_workflow_versions").get().created_at,before);
 assert.equal(createComfyRegistry(db).getVersionNote(original.id,original.revision).note,"保留配置");
 assert.deepEqual(registry.find(original.id,original.revision),original);
});

test("history protects task snapshots, project nodes and defaults; batch deletion is atomic and leaves graph files",async t=>{
 const {db,call}=fixture(t),root="/api/v1/comfy",id="protected";
 const versions=[1,2,3,4].map(n=>template(n,id));
 for(const version of versions)assert.equal((await call("POST",root+"/templates",{template:version})).statusCode,201);
 const url=v=>root+"/templates/"+id+"/"+v.revision;
 createProject(db,{id:"refs",document:{title:"Project",nodes:[{id:"n",type:"image",metadata:{comfyMediaPreset:{templateId:id,templateRevision:versions[1].revision}}}],connections:[]}});
 const snapshot={comfyTemplate:versions[2],comfyRequest:{nodes:[{templateId:id,templateRevision:versions[2].revision}]}};
 db.prepare("INSERT INTO jobs(id,principal,project_scope,idempotency_key,request_fingerprint,snapshot_json,execution_mode,status,created_at,updated_at) VALUES('history-task','local-owner','','key','fingerprint',?,'poll','failed',1,1)").run(JSON.stringify(snapshot));
 db.prepare("UPDATE ui_settings SET value_json=? WHERE name='model_config'").run(JSON.stringify({comfyWorkflowDefaults:{image:{templateId:id,templateRevision:versions[3].revision}}}));
 for(const [index,kind] of [[1,"projectNodes"],[2,"tasks"],[3,"defaults"]]){
  const refs=(await call("GET",url(versions[index])+"/references")).json().references;
  assert.equal(refs[kind].length,1);assert.equal(refs.count,1);
  assert.equal((await call("DELETE",url(versions[index]))).statusCode,409);
  const result=await call("POST",root+"/templates/delete-batch",{versions:[{templateId:id,revision:versions[0].revision},{templateId:id,revision:versions[index].revision}]});
  assert.equal(result.statusCode,409);assert.equal(result.json().details.references[kind].length,1);
  assert.equal((await call("GET",url(versions[0]))).statusCode,200);
 }
 assert.equal((await call("PUT",url(versions[0])+"/note",{note:"x".repeat(201)})).statusCode,400);
 assert.equal((await call("PUT",url(versions[0])+"/note",{note:"unused"})).statusCode,200);
 assert.equal((await call("GET",url(versions[0])+"/note")).json().note,"unused");
 assert.equal((await call("POST",root+"/templates/delete-batch",{versions:[{templateId:id,revision:versions[0].revision}]})).statusCode,200);
 assert.equal((await call("GET",url(versions[0]))).statusCode,404);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM comfy_template_version_notes").get().n,0);
 const hash=createHash("sha256").update(JSON.stringify(sort(versions[0].apiGraph))).digest("hex");
 assert.equal((await call("GET",root+"/workflows/"+id+"/graphs/"+hash)).json().available,true);
});

test("complete restore preserves binding settings, preset identity and existing nodes, rejects other workflows",async t=>{
 const {db,call}=fixture(t),root="/api/v1/comfy",old=template(1,"restore-full"),next=template(2,"restore-full");
 old.ports.unshift({id:"seed",label:"Seed",direction:"target",valueKind:"INT",defaultValue:1,choices:[{label:"One",value:1}],inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"seed"}]}});
 const {id,revision,...payload}=old;old.revision=createHash("sha256").update(JSON.stringify(sort(payload))).digest("hex");
 for(const v of [old,next,template(3,"other-workflow")])assert.equal((await call("POST",root+"/templates",{template:v})).statusCode,201);
 const preset={id:"restore-preset",name:"Keep this name",templateId:next.id,revision:next.revision};
 assert.equal((await call("PUT",root+"/presets/"+preset.id,preset)).statusCode,200);
 createProject(db,{id:"unchanged",document:{title:"Before",nodes:[{id:"n",type:"comfy:workflow",metadata:{comfyWorkflow:{templateId:next.id,templateRevision:next.revision}}}],connections:[]}});
 const document=db.prepare("SELECT document_json FROM projects WHERE id='unchanged'").get().document_json;
 const body={templateId:old.id,revision:old.revision,expectedTemplateId:next.id,expectedRevision:next.revision};
 const unrelated=template(3,"other-workflow");
 assert.equal((await call("POST",root+"/presets/"+preset.id+"/restore",{...body,templateId:unrelated.id,revision:unrelated.revision})).statusCode,404);
 assert.equal((await call("POST",root+"/presets/"+preset.id+"/restore",body)).statusCode,200);
 const selected=(await call("GET",root+"/presets")).json().presets.find(x=>x.id===preset.id);
 assert.equal(selected.name,preset.name);assert.equal(selected.revision,old.revision);
 const loaded=(await call("GET",root+"/templates/"+old.id+"/"+old.revision)).json().template;
 assert.deepEqual(loaded.ports,old.ports);assert.deepEqual(loaded.apiGraph,old.apiGraph);
 assert.equal(db.prepare("SELECT document_json FROM projects WHERE id='unchanged'").get().document_json,document);
 assert.equal((await call("POST",root+"/presets/"+preset.id+"/restore",body)).statusCode,409);
});

test("shared workflow histories do not duplicate rows and cross-template restore preserves variant name and parent",async t=>{
 const {db,call}=fixture(t),root="/api/v1/comfy",base=template(1,"shared-base"),variant=template(2,"shared-variant");
 for(const v of [base,variant])assert.equal((await call("POST",root+"/templates",{template:v})).statusCode,201);
 db.prepare("UPDATE comfy_workflow_versions SET workflow_id=? WHERE template_id=?").run(base.id,variant.id);
 const parent={id:"parent",name:"Base name",workflowId:base.id,templateId:base.id,revision:base.revision};
 const child={id:"child",name:"Variant name",workflowId:base.id,templateId:variant.id,revision:variant.revision,kind:"variant",parentId:parent.id};
 for(const p of [parent,child,{...child,id:"second-child"}])assert.equal((await call("PUT",root+"/presets/"+p.id,p)).statusCode,200);
 assert.equal((await call("GET",root+"/workflows/"+base.id+"/versions")).json().versions.length,2);
 assert.equal((await call("POST",root+"/presets/child/restore",{templateId:base.id,revision:base.revision,expectedTemplateId:variant.id,expectedRevision:variant.revision})).statusCode,200);
 const restored=(await call("GET",root+"/presets")).json().presets.find(p=>p.id===child.id);
 assert.equal(restored.name,child.name);assert.equal(restored.kind,"variant");assert.equal(restored.parentId,parent.id);
});
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
 assert.deepEqual((await call("GET","/api/v1/comfy/presets")).json().presets,[{...preset,workflowId:old.id,source:"user",kind:"base"}]);
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
test("v23 workflow history notes, complete CAS restore, reference guards and atomic batch deletion",async t=>{
 const {db,call}=fixture(t),root="/api/v1/comfy",id="workflow:history",old=template(1,id),next=template(2,id);
 await call("POST",root+"/templates",{template:old});await call("POST",root+"/templates",{template:next});
 const preset={id:"history-preset",name:"Named",workflowId:id,templateId:id,revision:next.revision,kind:"variant",parentId:"parent"};
 // A base preset keeps the case focused on its saved pointer and name.
 const base={...preset,kind:"base"};delete base.parentId;await call("PUT",root+"/presets/"+base.id,base);
 const note=await call("PUT",root+"/templates/"+encodeURIComponent(id)+"/"+old.revision+"/note",{note:"known good"});
 assert.equal(note.statusCode,200);assert.equal(db.prepare("SELECT revision FROM comfy_template_versions WHERE template_id=? AND revision=?").get(id,old.revision).revision,old.revision);
 const list=(await call("GET",root+"/workflows/"+encodeURIComponent(id)+"/versions")).json().versions;
 assert.equal(list.find(v=>v.revision===old.revision).note,"known good");assert.equal(list.find(v=>v.revision===next.revision).current,true);
 const restored=await call("POST",root+"/presets/"+base.id+"/restore",{templateId:id,revision:old.revision,expectedTemplateId:id,expectedRevision:next.revision});
 assert.equal(restored.statusCode,200,restored.body);assert.equal(db.prepare("SELECT name,kind,revision FROM comfy_presets WHERE id=?").get(base.id).name,"Named");
 assert.equal(db.prepare("SELECT kind FROM comfy_presets WHERE id=?").get(base.id).kind,"base");
 assert.equal((await call("POST",root+"/presets/"+base.id+"/restore",{templateId:id,revision:next.revision,expectedTemplateId:id,expectedRevision:next.revision})).statusCode,409);
 const refs=(await call("GET",root+"/templates/"+encodeURIComponent(id)+"/"+old.revision+"/references")).json().references;assert.equal(refs.presets[0].name,"Named");
 const batch=await call("POST",root+"/templates/delete-batch",{versions:[{templateId:id,revision:old.revision},{templateId:id,revision:next.revision}]});
 assert.equal(batch.statusCode,409);assert.ok(db.prepare("SELECT 1 FROM comfy_template_versions WHERE template_id=? AND revision=?").get(id,next.revision));
 assert.equal((await call("DELETE",root+"/templates/"+encodeURIComponent(id)+"/"+old.revision)).statusCode,409);
});
test("template rename updates shared metadata without creating a version or graph file and retains legacy hash verification",async t=>{
 const {db,call}=fixture(t),restored=fixture(t),base="/api/v1/comfy/templates",legacy=template();
 assert.equal((await call("POST",base,{template:legacy})).statusCode,201);
 const preset={id:"named-preset",name:"Old visible name",templateId:legacy.id,revision:legacy.revision};
 assert.equal((await call("PUT","/api/v1/comfy/presets/named-preset",preset)).statusCode,200);
 const beforeVersions=db.prepare("SELECT COUNT(*) n FROM comfy_template_versions").get().n;
 const beforeGraphs=db.prepare("SELECT COUNT(*) n FROM comfy_workflow_versions").get().n;
 const beforeHash=db.prepare("SELECT workflow_hash FROM comfy_template_versions WHERE template_id=?").get(legacy.id).workflow_hash;
 const renamed=await call("PUT",base+"/"+encodeURIComponent(legacy.id)+"/name",{name:"Renamed workflow"});
 assert.equal(renamed.statusCode,200,renamed.body);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM comfy_template_versions").get().n,beforeVersions);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM comfy_workflow_versions").get().n,beforeGraphs);
 assert.equal(db.prepare("SELECT workflow_hash FROM comfy_template_versions WHERE template_id=?").get(legacy.id).workflow_hash,beforeHash);
 const loaded=(await call("GET",base+"/"+encodeURIComponent(legacy.id)+"/"+legacy.revision)).json().template;
 assert.equal(loaded.name,"Renamed workflow");assert.equal(loaded.revisionName,legacy.name);
 assert.equal((await call("GET","/api/v1/comfy/presets")).json().presets[0].name,"Renamed workflow");
 const exported=await call("GET",base);
 assert.equal(exported.statusCode,200);assert.equal(exported.json().templates[0].revisionName,legacy.name);
 assert.equal((await restored.call("POST",base,{template:exported.json().templates[0]})).statusCode,201);
 assert.equal((await restored.call("GET",base+"/"+encodeURIComponent(legacy.id)+"/"+legacy.revision)).json().template.name,"Renamed workflow");
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
test("workflow graph is content-addressed on disk and is reloaded after reopening SQLite",async t=>{
 const root=mkdtempSync(join(tmpdir(),"atelier-comfy-workflows-test-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dbPath=join(root,"db","atelier.sqlite");mkdirSync(join(root,"db"),{recursive:true});
 let db=new DatabaseSync(dbPath);initializeSchema(db);const {createComfyRegistry}=await import("./comfy-registry.mjs");
 const registry=createComfyRegistry(db),base=template(4,"durable-workflow");registry.installMany([base]);
 const row=db.prepare("SELECT workflow_hash,payload_json FROM comfy_template_versions WHERE template_id=? AND revision=?").get(base.id,base.revision);
 const graphFile=join(root,"workflows",row.workflow_hash+".json");
 assert.equal(existsSync(graphFile),true);assert.deepEqual(JSON.parse(readFileSync(graphFile,"utf8")),base.apiGraph);
 assert.equal(Object.hasOwn(JSON.parse(row.payload_json),"apiGraph"),false);db.close();
 db=new DatabaseSync(dbPath);const reopened=createComfyRegistry(db);assert.deepEqual(reopened.find(base.id,base.revision),base);
 db.close();
});
test("legacy graph migration preserves revision and retries after a bad file blocks publication",async t=>{
 const root=mkdtempSync(join(tmpdir(),"atelier-comfy-migration-test-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dir=join(root,"workflows");mkdirSync(dir,{recursive:true});const db=new DatabaseSync(join(root,"legacy.sqlite"));initializeSchema(db);
 const legacy=template(7,"legacy-workflow"),payload={name:legacy.name,apiGraph:legacy.apiGraph,ports:legacy.ports,requirements:legacy.requirements};
 db.prepare("INSERT INTO comfy_template_versions(template_id,revision,payload_json,created_at,workflow_hash) VALUES(?,?,?,?,NULL)")
  .run(legacy.id,legacy.revision,JSON.stringify(sort(payload)),1);
 const hash=createHash("sha256").update(JSON.stringify(sort(legacy.apiGraph))).digest("hex"),path=join(dir,hash+".json");
 writeFileSync(path,"corrupt");const {createComfyRegistry}=await import("./comfy-registry.mjs");
 assert.throws(()=>createComfyRegistry(db,{workflowsDir:dir}),/comfy_workflow_file_corrupt/);
 const before=db.prepare("SELECT payload_json,workflow_hash FROM comfy_template_versions WHERE template_id=?").get(legacy.id);
 assert.equal(JSON.parse(before.payload_json).apiGraph["1"].inputs.seed,7);assert.equal(before.workflow_hash,null);
 unlinkSync(path);const registry=createComfyRegistry(db,{workflowsDir:dir});
 assert.deepEqual(registry.find(legacy.id,legacy.revision),legacy);
 assert.equal(db.prepare("SELECT workflow_hash FROM comfy_template_versions WHERE template_id=?").get(legacy.id).workflow_hash,hash);
 db.close();
});
test("a corrupt graph is isolated to its workflow instead of preventing registry startup",async t=>{
 const root=mkdtempSync(join(tmpdir(),"atelier-comfy-isolation-test-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,"db"),{recursive:true});const db=new DatabaseSync(join(root,"db","atelier.sqlite"));initializeSchema(db);
 const {createComfyRegistry}=await import("./comfy-registry.mjs"),registry=createComfyRegistry(db);
 const good=template(1,"good-workflow"),bad=template(2,"bad-workflow");registry.installMany([good,bad]);
 const hash=db.prepare("SELECT workflow_hash FROM comfy_template_versions WHERE template_id=?").get(bad.id).workflow_hash;
 writeFileSync(join(root,"workflows",hash+".json"),"corrupt");db.close();
 const reopened=new DatabaseSync(join(root,"db","atelier.sqlite")),loaded=createComfyRegistry(reopened);
 assert.deepEqual(loaded.find(good.id,good.revision),good);
 assert.throws(()=>loaded.find(bad.id,bad.revision),/comfy_workflow_file_corrupt/);reopened.close();
});
test("binding-only save atomically creates an independent variant snapshot and moves its pointer",async t=>{
 const {db,call}=fixture(t),base=template(11,"logical-workflow"),templates="/api/v1/comfy/templates";
 assert.equal((await call("POST",templates,{template:base})).statusCode,201);
 const basePreset={id:"base-preset",name:"Base",workflowId:base.id,templateId:base.id,revision:base.revision,source:"user",kind:"base"};
 assert.equal((await call("PUT","/api/v1/comfy/presets/base-preset",basePreset)).statusCode,200);
 const graphResponse=await call("POST","/api/v1/comfy/workflows/"+base.id+"/graphs",{graph:base.apiGraph});
 assert.equal(graphResponse.statusCode,200);const workflowHash=graphResponse.json().workflowHash;
 const changedPort={id:"seed",label:"Seed",direction:"target",valueKind:"INT",defaultValue:21,
  inputBinding:{mode:"literal",targets:[{nodeId:"1",inputName:"seed"}]},absentPolicy:{mode:"keep-template"}};
 const variantPayload={name:"Variant",apiGraph:base.apiGraph,ports:[...base.ports,changedPort],requirements:base.requirements};
 const variant={id:"variant-template",revision:createHash("sha256").update(JSON.stringify(sort(variantPayload))).digest("hex"),...variantPayload};
 const {apiGraph,...binding}=variant,preset={id:"variant-preset",name:"Variant",workflowId:base.id,templateId:variant.id,revision:variant.revision,source:"user",kind:"variant",parentId:basePreset.id};
 const saved=await call("PUT","/api/v1/comfy/presets/variant-preset/bind",{preset,workflowHash,binding});
 assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().workflowId,base.id);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comfy_template_versions WHERE template_id=?").get(variant.id).n,1);
 assert.equal(db.prepare("SELECT workflow_hash FROM comfy_workflow_versions WHERE template_id=?").get(variant.id).workflow_hash,workflowHash);
 assert.equal(db.prepare("SELECT workflow_id FROM comfy_presets WHERE id=?").get(preset.id).workflow_id,base.id);
 const invalidPayload={name:variant.name,apiGraph:variant.apiGraph,requirements:variant.requirements,ports:variant.ports.map(port=>port.id==="seed"?{...port,inputBinding:{mode:"literal",targets:[{nodeId:"404",inputName:"missing"}]}}:port)};
 const invalid={id:variant.id,revision:createHash("sha256").update(JSON.stringify(sort(invalidPayload))).digest("hex"),...invalidPayload};
 const {apiGraph:invalidGraph,...invalidBinding}=invalid,invalidPreset={...preset,revision:invalid.revision};
 const failed=await call("PUT","/api/v1/comfy/presets/variant-preset/bind",{preset:invalidPreset,workflowHash,binding:invalidBinding});
 assert.notEqual(failed.statusCode,200);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comfy_template_versions WHERE template_id=?").get(variant.id).n,1);
 assert.equal(db.prepare("SELECT revision FROM comfy_presets WHERE id=?").get(preset.id).revision,variant.revision);
});


test("name-independent template can be renamed repeatedly without legacy hash metadata",async t=>{
 const {db,call}=fixture(t),destination=fixture(t),base="/api/v1/comfy/templates";
 const original=template(42,"workflow:modern-rename");
 const {id,revision,name,...content}=original;
 original.revision=createHash("sha256").update(JSON.stringify(sort(content))).digest("hex");
 assert.equal((await call("POST",base,{template:original})).statusCode,201);
 for(const nextName of ["First rename","Second rename",name]){
  const response=await call("PUT",base+"/"+encodeURIComponent(id)+"/name",{name:nextName});
  assert.equal(response.statusCode,200,response.body);
  const loaded=(await call("GET",base+"/"+encodeURIComponent(id)+"/"+original.revision)).json().template;
  assert.equal(loaded.name,nextName);
  assert.equal(loaded.revision,original.revision);
  assert.equal(Object.hasOwn(loaded,"revisionName"),false);
  assert.doesNotThrow(()=>validateComfyTemplate(loaded));
  const {verifyTemplate}=await import("../comfy-workflow/compiler.mjs");
  assert.doesNotThrow(()=>verifyTemplate(loaded));
  assert.ok([200,201].includes((await destination.call("POST",base,{template:loaded})).statusCode));
 }
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comfy_template_versions").get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comfy_workflow_versions").get().n,1);
});
