import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, sha256 } from "./compiler.mjs";

export function createComfyStore(root) {
    mkdirSync(root,{recursive:true});
    const db = new DatabaseSync(join(root,"jobs.sqlite"));
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
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(principal,project,idem_key));
    CREATE TABLE IF NOT EXISTS artifacts(
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), workflow_node_id TEXT NOT NULL,
      port_id TEXT NOT NULL, capture_node_id TEXT NOT NULL, file_key TEXT NOT NULL, mime TEXT NOT NULL,
      sha256 TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL,
      UNIQUE(run_id,capture_node_id,file_key));
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
            if (fields.some(k=>!["compiled","capture_map","graph_hash","image_files","prompt_id","attempt_id","submit_marker","submission_started_at","error","cancel_requested"].includes(k))) throw new Error("illegal_run_update");
            q(`UPDATE runs SET status=?,updated_at=?${fields.map(k=>", "+k+"=?").join("")} WHERE id=?`).run(next,now(),...fields.map(k=>values[k]),id);
            return true;
        });
    }
    function listStatuses(statuses) {
        if (!statuses.length) return [];
        return q(`SELECT * FROM runs WHERE status IN (${statuses.map(()=>"?").join(",")}) ORDER BY created_at`).all(...statuses).map(row);
    }
    function resumeAfterRestart() {
        // submitting is NEVER re-sent automatically: the response may have been lost.
        return atomic(()=>{
            q("UPDATE runs SET status='submission_unknown', updated_at=? WHERE status='submitting'").run(now());
            q("UPDATE runs SET status='queued', updated_at=? WHERE status='preparing'").run(now());
        });
    }
    function addArtifact(run,cap,fileKey,bytes,mime) {
        const existing=q("SELECT * FROM artifacts WHERE run_id=? AND capture_node_id=? AND file_key=?")
            .get(run.id,cap.captureNodeId,fileKey);
        if(existing)return existing;
        const id=randomUUID(),digest=sha256(bytes),ext=mime==="image/png"?"png":mime==="image/jpeg"?"jpg":"webp";
        const path=join(root,"artifacts",id+"."+ext);
        durableFile(path,bytes);
        return atomic(()=>{
            q("INSERT OR IGNORE INTO artifacts(id,run_id,workflow_node_id,port_id,capture_node_id,file_key,mime,sha256,size,path) VALUES(?,?,?,?,?,?,?,?,?,?)")
                .run(id,run.id,cap.workflowNodeId,cap.portId,cap.captureNodeId,fileKey,mime,digest,bytes.length,path);
            return q("SELECT * FROM artifacts WHERE run_id=? AND capture_node_id=? AND file_key=?").get(run.id,cap.captureNodeId,fileKey);
        });
    }
    const artifacts=(id)=>q("SELECT id,run_id,workflow_node_id,port_id,capture_node_id,mime,sha256,size FROM artifacts WHERE run_id=? ORDER BY rowid").all(id);
    const artifact=(runId,id)=>q("SELECT * FROM artifacts WHERE id=? AND run_id=?").get(id,runId);
    const close=()=>db.close();
    return {db,root,loadInstances,changeInstance,deleteInstance,addTemplate,getTemplate,addAsset,asset,findByKey,addRun,read,cas,listStatuses,resumeAfterRestart,addArtifact,artifacts,artifact,close};
}
