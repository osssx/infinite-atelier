import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openMainDatabase} from "./database.mjs";
import {createProject} from "./projects.mjs";
import {createFileSkillRegistry} from "./file-skill-registry.mjs";
import {createBlobStore} from "./blob-store.mjs";
import {createAssistantChatService} from "./assistant-chat.mjs";
import {buildApp} from "./app.mjs";
import {rebuildBlobReferenceLedger,persistedBlobReferences} from "./blob-reference-ledger.mjs";

test("assistant script proposal requires separate consent; approved run creates an audit record and CAS artifact",async t=>{
 const root=mkdtempSync(join(tmpdir(),"atelier-assistant-script-"));
 const skillsDir=join(root,"skills"),data=join(root,"data"),folder=join(skillsDir,"assistant-tiny");
 mkdirSync(join(folder,"scripts"),{recursive:true});
 writeFileSync(join(folder,"SKILL.md"),
  "---\nname: assistant-tiny\ndescription: Script to generate a simple storyboard text\n---\nRun scripts/render.js to generate a storyboard.");
 writeFileSync(join(folder,"scripts","render.js"),
  "const fs=require('node:fs');const input=fs.readFileSync('input.txt','utf8');fs.writeFileSync('result.txt','STORY:'+input);console.log('done');");
 const db=openMainDatabase(data);
 createProject(db,{id:"p1",document:{nodes:[],connections:[]}});
 const skillRegistry=createFileSkillRegistry({skillsDir});
 const blobStore=createBlobStore({db,dataDir:data});
 const skill=skillRegistry.list().skills.find(entry=>entry.id==="assistant-tiny");
 assert.ok(skill);
 const vault={get:()=>({provider:"openai_compatible",hasKey:true,keyVersion:"v1"}),
  withSecretVersion:(_version,cb)=>cb(Buffer.from("private-key"))};
 const captured=[];
 const service=createAssistantChatService({vault,compatibleUpstreamCall:async(_url,options)=>{
  const body=JSON.parse(options.body);captured.push(body);
  const canPropose=body.tools?.some(item=>item.function.name==="run_skill_script");
  const message=canPropose?{role:"assistant",content:null,tool_calls:[{
   id:"script-req",type:"function",function:{name:"run_skill_script",arguments:JSON.stringify({
    skill_id:"assistant-tiny",script_path:"scripts/render.js",
    input_files_json:JSON.stringify({"input.txt":"晨光森林"}),output_files:["result.txt"]
   })}
  }]}:{role:"assistant",content:JSON.stringify({answer:"分镜已编排",actions:[
   {type:"create_node",ref:"n1",nodeType:"text",title:"分镜",content:"STORY:晨光森林"}]})};
  return new Response(JSON.stringify({choices:[{
   finish_reason:canPropose?"tool_calls":"stop",message
  }]}),{status:200});
 }});
 const app=buildApp({db,skillRegistry,blobStore,assistantChat:service,authorize:()=>true});
 t.after(async()=>{await app.close();db.close();rmSync(root,{recursive:true,force:true})});
 const chat={channelId:"c1",provider:"openai_compatible",model:"demo",baseUrl:"http://localhost:8080/v1",
  canvasActions:true,messages:[{role:"user",content:"请运行 assistant-tiny 生成分镜"}],
  skills:{mode:"manual",projectId:"p1",expectedRevision:skillRegistry.revision(),
   skillIds:["assistant-tiny"],versionPins:{"assistant-tiny":skill.activeVersion}}};
 const planned=await app.inject({method:"POST",url:"/api/v1/projects/p1/assistant/chat",payload:chat});
 assert.equal(planned.statusCode,200,planned.body);
 assert.deepEqual(planned.json().actions,[]);
 const proposal=planned.json().skillScriptProposal;
 assert.equal(proposal.script_path,"scripts/render.js");
 assert.equal(proposal.version,skill.activeVersion);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM skill_script_runs").get().n,0,
  "Inference must NOT run a proposed script");
 assert.doesNotMatch(planned.body,/const fs=require/);
 const approved=await app.inject({method:"POST",url:"/api/v1/skills/execute",
  payload:{project_id:"p1",...proposal}});
 assert.equal(approved.statusCode,200,approved.body);
 const result=approved.json();
 assert.equal(result.status,"completed");
 assert.match(result.stdout,/done/);
 assert.equal(result.artifacts[0].content,"STORY:晨光森林");
 const saved=db.prepare("SELECT * FROM skill_script_runs WHERE id=?").get(result.run_id);
 assert.equal(saved.status,"completed");
 assert.ok(JSON.parse(saved.blob_refs_json).includes(result.artifacts[0].blob_id));
 rebuildBlobReferenceLedger(db,{force:true});
 assert.ok(persistedBlobReferences(db).has(result.artifacts[0].blob_id));
 const completed=await app.inject({method:"POST",url:"/api/v1/projects/p1/assistant/chat",
  payload:{...chat,skillScriptProposalEnabled:false,messages:[{
   role:"user",content:"Approved run "+result.run_id+" returned "+result.artifacts[0].content+
    ". Use the result and do not call another script."
  }]}});
 assert.equal(completed.statusCode,200,completed.body);
 assert.equal(completed.json().actions[0].type,"create_node");
 assert.equal(captured.length,2);
 assert.ok(captured[0].tools.some(item=>item.function.name==="run_skill_script"));
 assert.ok(!captured[1].tools.some(item=>item.function.name==="run_skill_script"));
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM skill_script_runs").get().n,1);
 assert.deepEqual((await app.inject({method:"GET",url:"/api/v1/projects/p1"}))
  .json().document.nodes,[],"assistant remains read-only until browser applies actions");
 skillRegistry.update("assistant-tiny",{action:"enabled",enabled:false,
  expectedRevision:skillRegistry.revision()});
 const denied=await app.inject({method:"POST",url:"/api/v1/skills/execute",
  payload:{project_id:"p1",...proposal}});
 assert.equal(denied.statusCode,409,denied.body);
});
