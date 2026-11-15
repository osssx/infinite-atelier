/** P4.5f replay fixture: serve a COPY of previously proven real ComfyUI media.
 * No new generation, no user data writes and no real GPU submission.
 */
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {existsSync,writeFileSync} from "node:fs";
import {createLocalBackend} from "../server/backend/runtime.mjs";
import {startServer} from "../server/backend/app.mjs";

if(process.env.ATELIER_P45F_REPLAY!=="1")throw Error("replay_requires_opt_in");
const root=resolve(process.env.ATELIER_DATA_DIR??"");
const prefix=resolve(join(tmpdir(),"infinite-atelier-p45f-replay-"));
if(!root.startsWith(prefix)||!existsSync(join(root,"db","atelier.sqlite")))
 throw Error("replay_requires_isolated_SQLite_copy");
const port=Number(process.env.ATELIER_BACKEND_PORT);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error("bad_port");
const runtime=createLocalBackend({dataDir:root,
 comfyInstances:[{id:"comfy-local",url:"http://127.0.0.1:8188"}],
 enableComfyManagement:true,autoLocalSession:true,autoDispatch:false});
let closed=false;
async function close(){if(closed)return;closed=true;await runtime.close()}
for(const sig of ["SIGINT","SIGTERM"])
 process.on(sig,()=>void close().then(()=>process.exit(0)));
try{
 const db=runtime.db;
 const project=db.prepare("SELECT id,document_json FROM projects LIMIT 1").get();
 const task=db.prepare("SELECT id,status FROM assistant_tasks LIMIT 1").get();
 const jobs=db.prepare("SELECT id,status FROM jobs").all();
 const artifacts=db.prepare("SELECT kind,sha256 FROM artifacts").all();
 const materials=db.prepare("SELECT status FROM materializations").all();
 const document=JSON.parse(project.document_json);
 const video=document.nodes.find(node=>node.type==="video");
 const media=video?.metadata;
 if(!project?.id||task?.status!=="completed"||jobs.length!==2||
    jobs.some(job=>job.status!=="succeeded")||materials.length!==2||
    materials.some(row=>row.status!=="materialized")||!video||
    !artifacts.some(a=>a.kind==="video"&&
      media.storageKey==="cas:"+a.sha256)||
    !existsSync(join(root,"blobs",media.storageKey.slice(4,6),media.storageKey.slice(4))))
   throw Error("replay_not_trusted_completed_media");
 const marker={mode:"p45f_real_media_replay",projectId:project.id,
  taskId:task.id,backendOrigin:"http://127.0.0.1:"+port,
  videoSha:media.storageKey.slice(4),
  imageSha:artifacts.find(a=>a.kind==="image")?.sha256,
  jobCount:jobs.length,source:"copy_of_p45d_real_gpu_result"};
 await startServer(runtime.app,{host:"127.0.0.1",port});
 writeFileSync(join(root,"p45f-replay-fixture.json"),JSON.stringify(marker,null,2));
 console.log("P45F_REPLAY_READY "+JSON.stringify(marker));
}catch(error){
 console.error("P45F_REPLAY_FAILED",error.stack??String(error));
 await close();process.exitCode=1;
}