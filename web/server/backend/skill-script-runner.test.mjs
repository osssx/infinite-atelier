import test from "node:test";
import assert from "node:assert/strict";
import {runSkillScript,resolveSkillInterpreterAlias} from "./skill-script-runner.mjs";

const skill={skillId:"runner-test",version:"0123456789ab"};
function store(){const blobs=new Map();return {blobs,async put(parts,{mimeType="application/octet-stream",mime}={}){const id=String(blobs.size+1).padStart(64,"0"),data=Buffer.concat(parts.map(Buffer.from));blobs.set(id,data);return {blobId:id,sha256:id,mimeType:mime??mimeType}},async stat(id){const data=blobs.get(id);return {sha256:id,byteSize:data.length}}}}
const b64=text=>Buffer.from(text).toString("base64");

test("normalizes Windows Store python3 alias without changing other runtimes or explicit configuration",()=>{
 assert.equal(resolveSkillInterpreterAlias("python3",{platform:"win32",ext:".py",configured:"python"}),"python");
 assert.equal(resolveSkillInterpreterAlias("python3",{platform:"linux",ext:".py",configured:"python"}),"python3");
 assert.equal(resolveSkillInterpreterAlias("python3",{platform:"win32",ext:".py",configured:"C:/Tools/custom-python.exe"}),"python3");
 assert.equal(resolveSkillInterpreterAlias("node",{platform:"win32",ext:".js",configured:"node"}),"node");
});
test("Windows user-requested python3 still launches installed Python instead of an App Execution Alias",{
 skip:process.platform!=="win32"
},async()=>{
 const result=await runSkillScript({...skill,scriptPath:"scripts/run.py",
  source:"print('python-alias-works')",runtime:"python3",blobStore:store()});
 assert.equal(result.status,"completed");
 assert.equal(result.exit_code,0);
 assert.match(result.stdout,/python-alias-works/);
});

test("runs a frozen Node script with relative package files, inputs and stored outputs",async()=>{
 const blobStore=store();const packageFiles={"scripts/run.mjs":b64("import {readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path'; const x=await readFile(join('data','input.json'),'utf8'); await writeFile('prompt.txt','生成:'+JSON.parse(x).text); console.log('完成');"),"references/helper.txt":b64("reference")};
 const result=await runSkillScript({...skill,scriptPath:"scripts/run.mjs",source:"",packageFiles,inputFiles:{"data/input.json":'{"text":"光影"}'},outputFiles:["prompt.txt"],blobStore});
 assert.equal(result.status,"completed");assert.match(result.stdout,/完成/);assert.equal(result.artifacts[0].content,"生成:光影");assert.ok(blobStore.blobs.has(result.artifacts[0].blob_id));
});

test("bounds inline output while storing complete logs and recognizes nonzero exit",async()=>{
 const blobStore=store();const result=await runSkillScript({...skill,scriptPath:"scripts/out.js",source:"process.stdout.write('x'.repeat(50000)); process.exitCode=7",packageFiles:{},blobStore});
 assert.equal(result.status,"failed");assert.equal(result.exit_code,7);assert.ok(Buffer.byteLength(JSON.stringify(result))<=32*1024);assert.ok(result.stdout.length<=32*1024);assert.equal(result.stdout_truncated,true);
 assert.equal(blobStore.blobs.get(result.log_blobs.stdout).length,50000);
});

test("rejects unsafe input and output paths and prevents package overwrite",async()=>{
 const base={...skill,scriptPath:"scripts/run.js",source:"process.exit(0)",packageFiles:{"scripts/run.js":b64("process.exit(0)")},blobStore:store()};
 await assert.rejects(runSkillScript({...base,inputFiles:{"../outside":"x"}}),{code:"skill_script_input_path_unsafe"});
 await assert.rejects(runSkillScript({...base,inputFiles:{"scripts/run.js":"x"}}),{code:"skill_script_input_path_unsafe"});
 await assert.rejects(runSkillScript({...base,outputFiles:["C:/outside"]}),{code:"skill_script_path_unsafe"});
});

test("kills a timed out or cancelled process and cleans its isolated directory",async()=>{
 const base={...skill,scriptPath:"scripts/sleep.js",source:"setTimeout(()=>{},60000)",packageFiles:{},blobStore:store()};
 await assert.rejects(runSkillScript({...base,timeoutMs:50}),{code:"skill_script_timeout"});
 const controller=new AbortController();const pending=runSkillScript({...base,timeoutMs:0,signal:controller.signal});setTimeout(()=>controller.abort(),50);
 await assert.rejects(pending,{code:"skill_script_cancelled"});
});
test("settles cancellation that arrives while the frozen package is being materialized",async()=>{
 const controller=new AbortController();const packageFiles={"assets/large.txt":Buffer.alloc(6*1024*1024,97).toString("base64")};
 const pending=runSkillScript({...skill,scriptPath:"scripts/run.js",source:"process.exit(0)",packageFiles,blobStore:store(),signal:controller.signal});
 setImmediate(()=>controller.abort());
 await assert.rejects(pending,{code:"skill_script_cancelled"});
});

test("concurrent missing interpreters retain their original error instead of Windows ENOTEMPTY cleanup errors",async()=>{
 const old=process.env.ATELIER_RUNTIME_MISSING_TEST;
 process.env.ATELIER_RUNTIME_MISSING_TEST="Z:\\\\missing\\\\atelier-python.exe";
 try{
  const attempts=await Promise.allSettled(Array.from({length:6},()=>runSkillScript({
   ...skill,scriptPath:"scripts/compile.missing_test",source:"",blobStore:store()
  })));
  for(const result of attempts){
   assert.equal(result.status,"rejected");
   assert.equal(result.reason?.code,"skill_script_interpreter_missing");
  }
 }finally{
  if(old===undefined)delete process.env.ATELIER_RUNTIME_MISSING_TEST;
  else process.env.ATELIER_RUNTIME_MISSING_TEST=old;
 }
});

test("runs a locally configured custom runtime and reports a missing configured interpreter",async()=>{
 const priorCustom=process.env.ATELIER_RUNTIME_CSTM,priorMissing=process.env.ATELIER_RUNTIME_MISS;
 process.env.ATELIER_RUNTIME_CSTM=process.execPath;
 process.env.ATELIER_RUNTIME_MISS="Z:\\missing\\atelier-runtime.exe";
 try{
  const result=await runSkillScript({...skill,scriptPath:"scripts/task.cstm",source:"console.log('custom runtime')",packageFiles:{},blobStore:store()});
  assert.equal(result.status,"completed");assert.match(result.stdout,/custom runtime/);
  await assert.rejects(runSkillScript({...skill,scriptPath:"scripts/task.miss",source:"",packageFiles:{},blobStore:store()}),{code:"skill_script_interpreter_missing"});
 }finally{
  if(priorCustom===undefined)delete process.env.ATELIER_RUNTIME_CSTM;else process.env.ATELIER_RUNTIME_CSTM=priorCustom;
  if(priorMissing===undefined)delete process.env.ATELIER_RUNTIME_MISS;else process.env.ATELIER_RUNTIME_MISS=priorMissing;
 }
});
