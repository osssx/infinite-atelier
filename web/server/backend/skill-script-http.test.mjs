import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openMainDatabase} from "./database.mjs";
import {createProject} from "./projects.mjs";
import {createFileSkillRegistry} from "./file-skill-registry.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {buildApp} from "./app.mjs";
import {rebuildBlobReferenceLedger,persistedBlobReferences} from "./blob-reference-ledger.mjs";

const repo=join(import.meta.dirname,"../../../skills/moss-image-prompt-enhancer");
const id="moss-image-prompt-enhancer";
function fixture(t,{manifest=true}={}){
 const base=mkdtempSync(join(tmpdir(),"atelier-skill-http-")),skills=join(base,"skills"),data=join(base,"data"),folder=join(skills,id);
 mkdirSync(join(folder,"scripts"),{recursive:true});mkdirSync(join(folder,"references"),{recursive:true});
 copyFileSync(join(repo,"SKILL.md"),join(folder,"SKILL.md"));
 copyFileSync(join(repo,"scripts","compile_prompt.py"),join(folder,"scripts","compile_prompt.py"));
 copyFileSync(join(repo,"references","layout.md"),join(folder,"references","layout.md"));
 if(manifest)writeFileSync(join(folder,"execution.json"),JSON.stringify({entries:{compile:"scripts/compile_prompt.py"}}));
 const db=openMainDatabase(data);createProject(db,{id:"project-a",document:{nodes:[],connections:[]}});
 const skillRegistry=createFileSkillRegistry({skillsDir:skills}),blobStore=createBlobStore({db,dataDir:data});
 const app=buildApp({db,blobStore,skillRegistry,authorize:()=>true});
 t.after(async()=>{await app.close();db.close();rmSync(base,{recursive:true,force:true})});
 const current=()=>skillRegistry.list().skills.find(x=>x.id===id);
 const call=(payload)=>app.inject({method:"POST",url:"/api/v1/skills/execute",payload:{skill_id:id,version:current().activeVersion,project_id:"project-a",...payload}});
 return{base,folder,db,app,skillRegistry,blobStore,current,call};
}
const layout={width:1024,height:768,bbox_coord_space:"abs",bbox_format:"xyxy",summary:{caption:"A warm editorial poster with clear hierarchy."},items:[{label:"text",caption:"Large title",text:"春日海报",bbox:[96,80,928,248]}]};
const caption={caption:"A quiet glass greenhouse at dawn, soft light falling across leafy plants."};

test("HTTP execute compiles real MOSS Caption and Layout from a filesystem package without execution.json",async t=>{
 const f=fixture(t,{manifest:false});
 for(const draft of [caption,layout]){
  const result=await f.call({script_path:"scripts/compile_prompt.py",args:["draft.json","--output","prompt.txt"],input_files:{"draft.json":JSON.stringify(draft)},output_files:["prompt.txt"]});
  assert.equal(result.statusCode,200,result.body);assert.equal(result.json().status,"completed",result.body);
  const output=result.json().artifacts[0].content;
  if("caption" in draft)assert.equal(output.replace(/\r\n/g,"\n"),draft.caption+"\n");
  else{const compiled=JSON.parse(output);assert.equal(compiled.bbox_coord_space,"abs_centralized");assert.equal(compiled.items[0].text,"春日海报");}
 }
});

test("HTTP execute accepts an entry id from execution.json and records its blob refs in the ledger",async t=>{
 const f=fixture(t);
 const result=await f.call({entry_id:"compile",args:["draft.json","--output","prompt.txt"],input_files:{"draft.json":JSON.stringify(caption)},output_files:["prompt.txt"]});
 assert.equal(result.statusCode,200,result.body);const body=result.json();assert.equal(body.status,"completed");
 const run=f.db.prepare("SELECT * FROM skill_script_runs WHERE id=?").get(body.run_id);assert.ok(run);
 const refs=JSON.parse(run.blob_refs_json);assert.ok(refs.includes(body.artifacts[0].blob_id));
 rebuildBlobReferenceLedger(f.db,{force:true});assert.ok(persistedBlobReferences(f.db).has(body.artifacts[0].blob_id));
 assert.equal((await f.call({entry_id:"missing"})).statusCode,403);
});

test("HTTP execute enforces enabled state and project scope",async t=>{
 const f=fixture(t),entry=f.current();
 f.skillRegistry.update(id,{action:"scope",scope:{type:"project",projectId:"project-b"},expectedRevision:f.skillRegistry.revision()});
 assert.equal((await f.call({script_path:"scripts/compile_prompt.py"})).statusCode,409);
 f.skillRegistry.update(id,{action:"scope",scope:{type:"global"},expectedRevision:f.skillRegistry.revision()});
 f.skillRegistry.update(id,{action:"enabled",enabled:false,expectedRevision:f.skillRegistry.revision()});
 assert.equal((await f.call({script_path:"scripts/compile_prompt.py"})).statusCode,409);
 assert.ok(entry.activeVersion);
});

test("aborting a live HTTP execute request terminates the script and marks the run cancelled",async t=>{
 const f=fixture(t,{manifest:false});
 writeFileSync(join(f.folder,"scripts","wait.js"),"setTimeout(()=>{},60000)");
 const scan=f.skillRegistry.scan();assert.equal(scan.updated,1);
 const version=f.current().activeVersion;
 await f.app.listen({host:"127.0.0.1",port:0});
 const address=f.app.server.address(),controller=new AbortController();
 const pending=fetch(`http://127.0.0.1:${address.port}/api/v1/skills/execute`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({skill_id:id,version,project_id:"project-a",script_path:"scripts/wait.js"}),signal:controller.signal});
 await new Promise(resolve=>setTimeout(resolve,300));controller.abort();
 await assert.rejects(pending,{name:"AbortError"});
 for(let i=0;i<40;i++){
  const run=f.db.prepare("SELECT status FROM skill_script_runs ORDER BY created_at DESC LIMIT 1").get();
  if(run?.status==="skill_script_cancelled")return;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 assert.fail("aborted execution did not record cancellation");
});
