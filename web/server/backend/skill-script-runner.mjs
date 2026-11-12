import {spawn} from "node:child_process";
import {mkdtemp, mkdir, writeFile, readFile, lstat, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve, relative, dirname, isAbsolute, extname} from "node:path";
import {createWriteStream} from "node:fs";
import {once} from "node:events";

const LIMIT=28*1024,MAX_FILE=32*1024*1024,MAX_INPUT=8*1024*1024,MAX_LOG=256*1024*1024;
const fail=(code,message=code)=>Object.assign(Error(message),{code});
function safePath(value){
 if(typeof value!=="string"||!value||value.length>240||isAbsolute(value)||value.includes("\\")||/[\x00-\x1f\x7f<>:"|?*]/.test(value))return false;
 const parts=value.split("/");return parts.every(part=>part&&part!=="."&&part!==".."&&!/[. ]$/.test(part)&&!(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)))&&!parts.includes(".atelier");
}
/** Windows commonly resolves 'python3' to the WindowsApps Store alias, which
 * exits 9009 without stderr, even when a working Python 3 is installed as
 * 'python'. Only normalize this alias when 'python' is our configured default;
 * explicit custom interpreter configuration continues to take precedence.
 */
export function resolveSkillInterpreterAlias(command,{platform=process.platform,ext,configured}={}){
 return platform==="win32"&&ext===".py"&&command==="python3"&&configured==="python"?
  "python":command;
}
function runtimeFor(ext,runtime){
 const definitions={".py":["python","python3"],".js":["node"],".mjs":["node"],".cjs":["node"],".ps1":["powershell","pwsh"],".sh":["bash","sh"]};
 let mappings={};try{mappings=JSON.parse(process.env.ATELIER_RUNTIMES_JSON||"{}")}catch{throw fail("skill_script_runtime_config_invalid")}
 const mapping=mappings[ext]??{};
 const configured=process.env["ATELIER_RUNTIME_"+ext.slice(1).toUpperCase()]??mapping.executable??definitions[ext]?.[0];
 if(!configured)throw fail("skill_script_runtime_unsupported");
 const requested=runtime||configured;
 if(requested&&typeof requested!=="string")throw fail("skill_script_runtime_invalid");
 const aliases=Array.isArray(mapping.aliases)?mapping.aliases:[];
 if(requested!==configured&&!definitions[ext]?.includes(requested)&&!aliases.includes(requested))throw fail("skill_script_runtime_mismatch");
 const executable=resolveSkillInterpreterAlias(requested,{ext,configured});
 const configuredArgs=process.env["ATELIER_RUNTIME_ARGS_"+ext.slice(1).toUpperCase()];
 let fixedArgs=Array.isArray(mapping.args)?mapping.args:[];
 if(configuredArgs){try{fixedArgs=JSON.parse(configuredArgs)}catch{throw fail("skill_script_runtime_config_invalid")}
  if(!Array.isArray(fixedArgs)||fixedArgs.some(x=>typeof x!=="string"))throw fail("skill_script_runtime_config_invalid");}
 return {executable,fixedArgs};
}
function mimeFor(path,bytes){
 const ext=extname(path).toLowerCase();
 const known={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",
  ".mp4":"video/mp4",".mov":"video/quicktime",".webm":"video/webm",".mkv":"video/x-matroska",
  ".wav":"audio/wav",".flac":"audio/flac",".ogg":"audio/ogg",".mp3":"audio/mpeg"};
 if(known[ext])return known[ext];
 if(bytes.includes(0))throw fail("skill_script_output_mime_unsupported",path);
 try{new TextDecoder("utf-8",{fatal:true}).decode(bytes)}catch{throw fail("skill_script_output_mime_unsupported",path)}
 return "text/plain";
}
function withInlineBudget(result){
 const values=[];
 for(const item of result.artifacts??[])if(typeof item.content==="string"){const field={type:"artifact",item,text:item.content,value:"",set(value){this.value=value;this.item.content=value}};values.push(field);delete item.content;}
 values.push({type:"stdout",text:result._stdout,value:"",set(value){this.value=value;result.stdout=value}});
 values.push({type:"stderr",text:result._stderr,value:"",set(value){this.value=value;result.stderr=value}});
 delete result._stdout;delete result._stderr;result.stdout="";result.stderr="";
 let used=Buffer.byteLength(JSON.stringify(result));
 const budget=LIMIT-512;
 for(const field of values){
  if(used>=budget){field.set("");continue;}
  const points=[...field.text];let low=0,high=points.length;
  while(low<high){const mid=Math.ceil((low+high)/2);field.set(points.slice(0,mid).join(""));
   if(Buffer.byteLength(JSON.stringify(result))<=budget)low=mid;else high=mid-1;}
  field.set(points.slice(0,low).join(""));used=Buffer.byteLength(JSON.stringify(result));
 }
 const artifactTruncated=values.some(field=>field.type==="artifact"&&field.value.length<field.text.length);
 result.stdout_truncated||=result.stdout.length<values.find(v=>v.type==="stdout").text.length;
 result.stderr_truncated||=result.stderr.length<values.find(v=>v.type==="stderr").text.length;
 if(artifactTruncated)result.artifacts_truncated=true;
 return result;
}
function killTree(child){
 if(!child.pid)return;
 if(process.platform==="win32")spawn("taskkill",["/pid",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"}).on("error",()=>{});
 else {try{process.kill(-child.pid,"SIGKILL")}catch{child.kill("SIGKILL")}}
}
async function within(root,path){
 if(!safePath(path))throw fail("skill_script_path_unsafe");
 const full=resolve(root,...path.split("/")),rel=relative(root,full);
 if(!rel||rel.startsWith("..")||isAbsolute(rel))throw fail("skill_script_path_unsafe");
 let current=root;
 for(const part of rel.split(/[\\/]/)){current=join(current,part);try{if((await lstat(current)).isSymbolicLink())throw fail("skill_script_path_unsafe")}catch(e){if(e.code!=="ENOENT")throw e}}
 return full;
}
/** Execute only an immutable package script through a fixed, extension-selected interpreter. */
export async function runSkillScript({skillId,version,scriptPath,source,packageFiles={},args=[],inputFiles={},outputFiles=[],runtime,signal,timeoutMs,blobStore}){
 if(signal?.aborted)throw fail("skill_script_cancelled","Skill script cancelled");
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillId)||!/^[a-f0-9]{12}$/.test(version))throw fail("skill_script_package_invalid");
 if(!safePath(scriptPath)||!scriptPath.startsWith("scripts/")||typeof source!=="string")throw fail("skill_script_path_unsafe");
 if(!Array.isArray(args)||args.length>64||args.some(x=>typeof x!=="string"||x.length>8192))throw fail("skill_script_arguments_invalid");
 if(!inputFiles||typeof inputFiles!=="object"||Array.isArray(inputFiles)||!outputFiles||!Array.isArray(outputFiles))throw fail("skill_script_files_invalid");
 const total=Object.values(inputFiles).reduce((sum,value)=>sum+(typeof value==="string"?Buffer.byteLength(value):MAX_INPUT+1),0);
 if(total>MAX_INPUT)throw fail("skill_script_input_too_large");
 if(timeoutMs===undefined){const configured=process.env.ATELIER_SKILL_SCRIPT_TIMEOUT_MS;timeoutMs=configured==="0"?0:configured?Number(configured):300000;}
 if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw fail("skill_script_timeout_config_invalid");
 const ext=extname(scriptPath).toLowerCase(),{executable,fixedArgs}=runtimeFor(ext,runtime);
 const root=await mkdtemp(join(tmpdir(),"infinite-atelier-skill-"));
 let timeout;
 try{
  for(const [path,encoded] of Object.entries(packageFiles)){
   if(!safePath(path)||typeof encoded!=="string")throw fail("skill_script_package_invalid");
   const data=Buffer.from(encoded,"base64");if(data.toString("base64")!==encoded)throw fail("skill_script_package_invalid");
   const target=await within(root,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,data,{flag:"wx",mode:0o600});
  }
  const script=await within(root,scriptPath);
  if(!Object.hasOwn(packageFiles,scriptPath)){await mkdir(dirname(script),{recursive:true});await writeFile(script,source,{flag:"wx",mode:0o600});}
  for(const [path,value] of Object.entries(inputFiles)){
   if(!safePath(path)||path.startsWith("scripts/"))throw fail("skill_script_input_path_unsafe");
   const target=await within(root,path);try{await lstat(target);throw fail("skill_script_input_overwrite",path)}catch(error){if(error.code!=="ENOENT")throw error}
   await mkdir(dirname(target),{recursive:true});await writeFile(target,value,{flag:"wx",mode:0o600});
  }
  const output=new Promise((resolveOutput,reject)=>{
   let stdout="",stderr="",outBytes=0,errBytes=0,settled=false,terminationError=null;
   const stdoutFile=join(root,".stdout.log"),stderrFile=join(root,".stderr.log");
   const stdoutStream=createWriteStream(stdoutFile,{mode:0o600}),stderrStream=createWriteStream(stderrFile,{mode:0o600});
   const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timeout);signal?.removeEventListener("abort",abort);error?reject(error):resolveOutput(result)};
   let activeChild=null,retriedPython=false;
   const abort=()=>{
    terminationError=fail("skill_script_cancelled","Skill script cancelled");
    if(activeChild?.pid)killTree(activeChild);
    else{stdoutStream.end();stderrStream.end();Promise.all([once(stdoutStream,"finish"),once(stderrStream,"finish")]).then(()=>finish(terminationError),error=>finish(error));}
   };
   if(signal?.aborted){abort();return;}signal?.addEventListener("abort",abort,{once:true});
   const start=command=>{
    if(terminationError||settled)return;
    const currentChild=spawn(command,[...fixedArgs,script,...args],{cwd:root,shell:false,windowsHide:true,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"],env:{...process.env, ...(ext===".py"?{PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"}:{})}});activeChild=currentChild;
    currentChild.stdout.on("data",chunk=>{outBytes+=chunk.length;stdoutStream.write(chunk);if(stdout.length<LIMIT)stdout+=chunk.toString("utf8").slice(0,LIMIT-stdout.length)});
    currentChild.stderr.on("data",chunk=>{errBytes+=chunk.length;stderrStream.write(chunk);if(stderr.length<LIMIT)stderr+=chunk.toString("utf8").slice(0,LIMIT-stderr.length)});
    currentChild.stdout.on("error",error=>finish(fail("skill_script_output_failed",error.message)));
    currentChild.stderr.on("error",error=>finish(fail("skill_script_output_failed",error.message)));
    currentChild.on("error",error=>{
     if(error.code==="ENOENT"&&command==="python"&&ext===".py"&&!retriedPython&&!terminationError&&!settled){retriedPython=true;start("python3");return;}
     // A missing executable can fail before the log write streams open.
     // Wait for both streams to finish before the temporary root is removed;
     // otherwise Windows can throw ENOTEMPTY and hide the interpreter error.
     Promise.all([
      new Promise(resolve=>stdoutStream.end(resolve)),
      new Promise(resolve=>stderrStream.end(resolve))
     ]).then(()=>finish(fail("skill_script_interpreter_missing",error.message)),finish);
    });
    currentChild.on("close",(code,signalName)=>{if(currentChild!==activeChild||settled)return;onClose(code,signalName)});
   };
   const onClose=async(code,signalName)=>{
    try{
     stdoutStream.end();stderrStream.end();await Promise.all([once(stdoutStream,"finish"),once(stderrStream,"finish")]);
     if(terminationError)return finish(terminationError);
     const artifacts=[];
     for(const path of code===0?outputFiles:[]){const target=await within(root,path);let bytes;try{bytes=await readFile(target)}catch(e){if(e.code==="ENOENT")throw fail("skill_script_output_missing",path);throw e}
      if(bytes.length>MAX_FILE)throw fail("skill_script_output_too_large",path);
      if(!blobStore)throw fail("skill_script_artifact_store_unavailable");
      const mime=mimeFor(path,bytes),blob=await blobStore.put([bytes],{mime});
      let content;
      if(bytes.length<=20*1024&&!bytes.includes(0))try{content=new TextDecoder("utf-8",{fatal:true}).decode(bytes)}catch{/* binary output */}
      artifacts.push({path,blob_id:blob.blobId,mime,byte_length:bytes.length,...(content!==undefined?{content}:{})});}
     const logRefs={};
     for(const [name,path,size] of [["stdout",stdoutFile,outBytes],["stderr",stderrFile,errBytes]])if(size){
      const blob=await blobStore.put([await readFile(path)],{mime:"text/plain"});logRefs[name]=blob.blobId;
     }
     const result={skill_id:skillId,version,script_path:scriptPath,status:code===0?"completed":"failed",exit_code:code,signal:signalName,
      stdout_bytes:outBytes,stderr_bytes:errBytes,stdout_truncated:outBytes>stdout.length,stderr_truncated:errBytes>stderr.length,log_blobs:logRefs,artifacts,_stdout:stdout,_stderr:stderr};
     finish(null,withInlineBudget(result));
    }catch(error){finish(error)}
   };
   start(executable);
   if(timeoutMs>0)timeout=setTimeout(()=>{terminationError=fail("skill_script_timeout","Skill script exceeded the configured timeout");killTree(activeChild)},timeoutMs);
  });
  return await output;
 }finally{await rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:75});}
}
