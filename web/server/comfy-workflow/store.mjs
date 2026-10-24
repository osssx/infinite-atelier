import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { detectArtifactMime, captureLimits } from "./capture-adapters.mjs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, sha256 } from "./compiler.mjs";

export function createComfyStore(root,{maxRunBytes=4_000_000_000}={}) {
    if(!Number.isSafeInteger(maxRunBytes) || maxRunBytes<1)throw new Error("invalid_comfy_run_quota");
    mkdirSync(root,{recursive:true});
    const db = new DatabaseSync(join(root,"jobs-v2.sqlite"));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS templates(id TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,revision));
    CREATE TABLE IF NOT EXISTS comfy_instances(id TEXT PRIMARY KEY, url TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS comfy_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, project TEXT NOT NULL, idem_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
      compiled TEXT, capture_map TEXT, graph_hash TEXT, image_files TEXT,
      prompt_id TEXT, attempt_id TEXT, submit_marker TEXT, submission_started_at INTEGER,
      error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
      capture_attempts INTEGER NOT NULL DEFAULT 0, next_collect_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(principal,project,idem_key));
    CREATE TABLE IF NOT EXISTS artifacts(
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), workflow_node_id TEXT NOT NULL,
      port_id TEXT NOT NULL, capture_node_id TEXT NOT NULL, item_key TEXT NOT NULL,
      item_index INTEGER NOT NULL, kind TEXT NOT NULL, adapter_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
      mime TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL,
      UNIQUE(run_id,port_id,item_key));
    CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status,created_at);`);
    const now=()=>Date.now();
    const q=(sql)=>db.prepare(sql);
    const row=(r)=>r ? {
        ...r, request:JSON.parse(r.request), compiled:r.compiled?JSON.parse(r.compiled):null,
        captureMap:r.capture_map?JSON.parse(r.capture_map):[], imageFiles:r.image_files?JSON.parse(r.image_files):{},
        cancelRequested:Boolean(r.cancel_requested)
    }:null;
    const read=(id)=>row(q("SELECT * FROM runs WHERE id=?").get(id));
    const atomic=(fn)=>{
        db.exec("BEGIN IMMEDIATE");
        try { const v=fn();db.exec("COMMIT");return v; }
        catch(e) { db.exec("ROLLBACK");throw e; }
    };
    function durableFile(path,bytes) {
        mkdirSync(dirname(path),{recursive:true});
        const temp=path+".part-"+randomUUID();
        writeFileSync(temp,bytes);
        const fd=openSync(temp,"r+");try{fsyncSync(fd);}finally{closeSync(fd);}
        renameSync(temp,path);
    }
    function loadInstances(initial) {
        return atomic(()=>{
            const seeded=q("SELECT value FROM comfy_meta WHERE key='instances_initialized'").get();
            if(!seeded) {
                for(const item of initial.values())q("INSERT INTO comfy_instances(id,url) VALUES(?,?)").run(item.id,item.url);
                q("INSERT INTO comfy_meta(key,value) VALUES('instances_initialized','1')").run();
            }
            return new Map(q("SELECT id,url FROM comfy_instances ORDER BY id").all().map(item=>[item.id,item]));
        });
    }
    function changeInstance(instance,oldId) {
        return atomic(()=>{
            const total=q("SELECT COUNT(*) AS n FROM comfy_instances").get().n;
            if(oldId) {
                if(!q("SELECT id FROM comfy_instances WHERE id=?").get(oldId))throw Object.assign(new Error("instance_not_found"),{status:404});
                if(instance.id!==oldId && q("SELECT id FROM comfy_instances WHERE id=?").get(instance.id))throw Object.assign(new Error("instance_id_conflict"),{status:409});
                q("UPDATE comfy_instances SET id=?,url=? WHERE id=?").run(instance.id,instance.url,oldId);
            }else {
                if(total>=16)throw Object.assign(new Error("instance_limit_reached"),{status:409});
                if(q("SELECT id FROM comfy_instances WHERE id=?").get(instance.id))throw Object.assign(new Error("instance_id_conflict"),{status:409});
                q("INSERT INTO comfy_instances(id,url) VALUES(?,?)").run(instance.id,instance.url);
            }
        });
    }
    function deleteInstance(id) {
        return atomic(()=>{
            if(!q("SELECT id FROM comfy_instances WHERE id=?").get(id))throw Object.assign(new Error("instance_not_found"),{status:404});
            q("DELETE FROM comfy_instances WHERE id=?").run(id);
        });
    }
    function addTemplate(template) {
        const content=canonical(template);
        return atomic(()=>{
            const old=q("SELECT payload FROM templates WHERE id=? AND revision=?").get(template.id,template.revision);
            if (old && old.payload !== content) throw Object.assign(new Error("template_immutable_conflict"),{status:409});
            if (!old) q("INSERT INTO templates(id,revision,payload) VALUES(?,?,?)").run(template.id,template.revision,content);
            return old?"existing":"created";
        });
    }
    function getTemplate(id,rev) {
        const entry=q("SELECT payload FROM templates WHERE id=? AND revision=?").get(id,rev);
        return entry?JSON.parse(entry.payload):null;
    }
    function addAsset(bytes,mime) {
        if (!Buffer.isBuffer(bytes) || bytes.length<8) throw Object.assign(new Error("image_upload_empty"),{status:400});
        const digest=sha256(bytes), id=randomUUID(),ext=mime==="image/png"?"png":mime==="image/jpeg"?"jpg":"webp";
        const filename=join(root,"inputs",id+"."+ext);
        durableFile(filename,bytes);
        atomic(()=>q("INSERT INTO assets(id,sha256,mime,size,path,created_at) VALUES(?,?,?,?,?,?)").run(id,digest,mime,bytes.length,filename,now()));
        return {assetId:id,sha256:digest,byteSize:bytes.length,mimeType:mime,lease:"retained-until-explicit-cleanup"};
    }
    const asset=(id)=>q("SELECT * FROM assets WHERE id=?").get(id);
    const findByKey=(principal,project,key)=>row(q("SELECT * FROM runs WHERE principal=? AND project=? AND idem_key=?").get(principal,project,key));
    function addRun(principal,request,fingerprint) {
        return atomic(()=>{
            const existing=q("SELECT * FROM runs WHERE principal=? AND project=? AND idem_key=?").get(principal,request.projectId,request.idempotencyKey);
            if (existing) {
                if (existing.fingerprint!==fingerprint) throw Object.assign(new Error("idempotency_key_conflict"),{status:409});
                return {run:row(existing),existing:true};
            }
            const id=randomUUID(),ts=now();
            q("INSERT INTO runs(id,principal,project,idem_key,fingerprint,request,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
                .run(id,principal,request.projectId,request.idempotencyKey,fingerprint,canonical(request),"queued",ts,ts);
            return {run:read(id),existing:false};
        });
    }
    function cas(id,states,next,values={}) {
        const allowed=Array.isArray(states)?states:[states];
        return atomic(()=>{
            const existing=q("SELECT status FROM runs WHERE id=?").get(id);
            if (!existing||!allowed.includes(existing.status)) return false;
            const fields=Object.entries(values).map(([key])=>key);
            if (fields.some(k=>!["compiled","capture_map","graph_hash","image_files","prompt_id","attempt_id","submit_marker","submission_started_at","error","cancel_requested","capture_attempts","next_collect_at"].includes(k))) throw new Error("illegal_run_update");
            q(`UPDATE runs SET status=?,updated_at=?${fields.map(k=>", "+k+"=?").join("")} WHERE id=?`).run(next,now(),...fields.map(k=>values[k]),id);
            return true;
        });
    }
    function listStatuses(statuses) {
        if (!statuses.length) return [];
        return q(`SELECT * FROM runs WHERE status IN (${statuses.map(()=>"?").join(",")}) ORDER BY created_at`).all(...statuses).map(row);
    }
    function resumeAfterRestart() {
        // A previous gateway's "comfy_upstream_400" means a real HTTP validation response
        // arrived from /prompt: Comfy did not enqueue the job. Repair only that provable case.
        // All transport/5xx uncertainties stay locked; never risk submitting the same GPU job twice.
        return atomic(()=>{
            q("UPDATE runs SET status='failed', updated_at=? WHERE status='submission_unknown' AND prompt_id IS NULL AND error IN (?,?)")
                .run(now(),"Error: comfy_upstream_400","Error: comfy_upstream_422");
            q("UPDATE runs SET status='submission_unknown', updated_at=? WHERE status='submitting'").run(now());
            q("UPDATE runs SET status='queued', updated_at=? WHERE status='preparing'").run(now());
        });
    }
    async function addArtifact(run,cap,itemKey,index,source,reportedMime,metadata={}) {
        const existing=q("SELECT * FROM artifacts WHERE run_id=? AND port_id=? AND item_key=?")
            .get(run.id,cap.portId,itemKey);
        if(existing)return existing;
        const alreadyStored=q("SELECT COALESCE(SUM(size),0) AS total FROM artifacts WHERE run_id=?").get(run.id).total;
        const id=randomUUID(),tmp=join(root,"artifacts",id+".part"),digest=createHash("sha256");
        mkdirSync(dirname(tmp),{recursive:true});
        const handle=await open(tmp,"wx");
        let size=0,head=Buffer.alloc(0),saved=false,detected;
        const decoder=cap.kind==="text"?new TextDecoder("utf-8",{fatal:true}):null;
        const input=Buffer.isBuffer(source)?[source]:source;
        try {
            for await(const raw of input) {
                const bytes=Buffer.from(raw);
                size+=bytes.length;
                if(size>captureLimits[cap.kind] || alreadyStored+size>maxRunBytes)
                    throw Object.assign(new Error("quota_exceeded"),{code:"quota_exceeded"});
                if(head.length<64)head=Buffer.concat([head,bytes.subarray(0,64-head.length)]);
                if(decoder) {
                    decoder.decode(bytes,{stream:true});
                    if(bytes.includes(0))throw Object.assign(new Error("invalid_text_content"),{code:"invalid_text_content"});
                }
                digest.update(bytes);
                await handle.writeFile(bytes);
            }
            if(decoder)decoder.decode();
            if(!size && cap.kind!=="text")throw Object.assign(new Error("capture_empty"),{code:"capture_empty"});
            detected=detectArtifactMime(cap.kind,head,reportedMime);
            const validExtensions={
                "image/png":["png"],"image/jpeg":["jpg","jpeg"],"image/webp":["webp"],
                "video/mp4":["mp4","m4v"],"video/webm":["webm"],"video/x-matroska":["mkv"],
                "audio/wav":["wav"],"audio/flac":["flac"],"audio/ogg":["ogg","oga"],
                "audio/mpeg":["mp3"],"text/plain":["txt","text"]
            };
            if(metadata.filename && !validExtensions[detected]?.includes(metadata.filename.split(".").pop().toLowerCase()))
                throw Object.assign(new Error("captured_extension_mismatch"),{code:"captured_extension_mismatch"});
            await handle.sync();await handle.close();
            const ext=({"image/png":"png","image/jpeg":"jpg","image/webp":"webp",
                "video/mp4":"mp4","video/webm":"webm","video/x-matroska":"mkv",
                "audio/wav":"wav","audio/flac":"flac","audio/ogg":"ogg","audio/mpeg":"mp3",
                "text/plain":"txt"})[detected];
            const file=join(root,"artifacts",id+"."+ext);
            await rename(tmp,file);saved=true;
            return atomic(()=>{
                q("INSERT OR IGNORE INTO artifacts(id,run_id,workflow_node_id,port_id,capture_node_id,item_key,item_index,kind,adapter_id,metadata_json,mime,sha256,size,path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
                    .run(id,run.id,cap.workflowNodeId,cap.portId,cap.captureNodeId,itemKey,index,
                        cap.kind,cap.adapterId,canonical(metadata),detected,digest.digest("hex"),size,file);
                const row=q("SELECT * FROM artifacts WHERE run_id=? AND port_id=? AND item_key=?")
                    .get(run.id,cap.portId,itemKey);
                if(row.id!==id)unlinkSync(file);
                return row;
            });
        } catch(error) {
            try {await handle.close();}catch {}
            try {await unlink(tmp);}catch {}
            throw error;
        }
    }
    const artifacts=(id)=>q("SELECT id,run_id,workflow_node_id,port_id,capture_node_id,item_key,item_index,kind,adapter_id,metadata_json,mime,sha256,size FROM artifacts WHERE run_id=? ORDER BY port_id,item_index").all(id);
    const artifact=(runId,id)=>q("SELECT * FROM artifacts WHERE id=? AND run_id=?").get(id,runId);
    const close=()=>db.close();
    return {db,root,loadInstances,changeInstance,deleteInstance,addTemplate,getTemplate,addAsset,asset,findByKey,addRun,read,cas,listStatuses,resumeAfterRestart,addArtifact,artifacts,artifact,close};
}
