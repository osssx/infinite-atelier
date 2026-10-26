import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,readFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initializeSchema,INITIAL_SCHEMA_SQL} from "./schema.mjs";
import {createWindowsDpapiProtector} from "./credential-protection.mjs";
import {createCredentialVault} from "./credential-vault.mjs";
import {createLocalBackend} from "./runtime.mjs";
import {openMainDatabase} from "./database.mjs";

const temp=()=>mkdtempSync(join(tmpdir(),"atelier-credential-"));
const fakeToken="TEST_ONLY_KEY_NEVER_PERSIST_IN_CLEAR_VAULT_29374";
const protectorFactory=()=>createWindowsDpapiProtector();

test("v1 database migrates through credential schema v2 to coordinator schema v3 without losing projects/jobs",t=>{
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());
 db.exec(INITIAL_SCHEMA_SQL);
 db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(1,1)").run();
 db.prepare("INSERT INTO projects(id,document_json,revision) VALUES(?,?,?)").run("keep",'{"nodes":[],"connections":[]}',12);
 initializeSchema(db);initializeSchema(db);
 assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,10);
 assert.equal(db.prepare("SELECT revision FROM projects WHERE id='keep'").get().revision,12);
 assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='credential_versions'").get().name,"credential_versions");
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n,2);
});
test("DPAPI ciphertext is user-scoped and bound to channel/version entropy",()=>{
 if(process.platform!=="win32")return;
 const p=protectorFactory();
 const plain=Buffer.from("synthetic-test-only");const aad="InfiniteAtelier:v2:channel-1:version-1";
 const cipher=p.protect(plain,aad);
 assert.notDeepEqual(cipher,plain);
 assert.deepEqual(p.unprotect(cipher,aad),plain);
 assert.throws(()=>p.unprotect(cipher,"InfiniteAtelier:v2:channel-2:version-1"),/credential_protection_unavailable/);
});
test("vault keeps immutable encrypted versions; rotation retains old; revoke is explicit",t=>{
 if(process.platform!=="win32")return;
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());initializeSchema(db);
 const vault=createCredentialVault({db,protector:protectorFactory()});
 const created=vault.create({id:"channelA",provider:"openai",displayName:"Provider A",apiKey:fakeToken});
 const first=created.keyVersion;
 assert.equal(created.hasKey,true);
 assert.equal(vault.list().length,1);
 assert.equal(JSON.stringify(vault.list()).includes(fakeToken),false);
 assert.equal(JSON.stringify(vault.listVersions("channelA")).includes("ciphertext"),false);
 const row=db.prepare("SELECT ciphertext FROM credential_versions WHERE id=?").get(first);
 assert.ok(row.ciphertext instanceof Uint8Array);
 assert.equal(Buffer.from(row.ciphertext).includes(Buffer.from(fakeToken)),false);
 assert.equal(vault.withSecretVersion(first,b=>b.toString("utf8"),{channelId:"channelA"}),fakeToken);
 assert.throws(()=>vault.rotate("channelA",{apiKey:"key2",expectedKeyVersion:"wrong"}),/credential_version_conflict/);
 const rotated=vault.rotate("channelA",{apiKey:"second-key",expectedKeyVersion:first});
 assert.notEqual(rotated.keyVersion,first);
 assert.equal(vault.withSecretVersion(first,b=>b.toString("utf8"),{channelId:"channelA"}),fakeToken);
 assert.equal(vault.withSecretVersion(rotated.keyVersion,b=>b.toString("utf8")),"second-key");
 assert.throws(()=>vault.checkReference(first,"wrongchannel"),/credential_missing/);
 assert.throws(()=>db.prepare("UPDATE credential_versions SET ciphertext=? WHERE id=?").run(Buffer.from("fake"),first),/immutable_credential_version/);
 assert.throws(()=>db.prepare("DELETE FROM credential_versions WHERE id=?").run(first),/immutable_credential_version/);
 vault.revoke("channelA",first);
 assert.equal(vault.get("channelA").keyVersion,rotated.keyVersion);
 assert.throws(()=>vault.checkReference(first),/credential_revoked/);
 vault.revoke("channelA",rotated.keyVersion);
 assert.equal(vault.get("channelA").hasKey,false);
 assert.equal(vault.get("channelA").keyVersion,null);
 const fresh=vault.rotate("channelA",{apiKey:"third-key",expectedKeyVersion:null});
 assert.equal(vault.listVersions("channelA").length,3);
 assert.ok(fresh.hasKey);
});
test("authenticated channel routes never expose ciphertext or cleartext; Jobs freeze version; restart decrypts",async t=>{
 if(process.platform!=="win32")return;
 const dataDir=temp();
 const runtime=createLocalBackend({dataDir});
 let closed=false;
 t.after(async()=>{if(!closed)await runtime.close();rmSync(dataDir,{recursive:true,force:true})});
 const app=runtime.app, token=runtime.sessionAuth.bootstrapToken;
 const exchange=await app.inject({method:"POST",url:"/api/v1/session",payload:{},
  headers:{host:"localhost",origin:"http://localhost",authorization:"Bearer "+token}});
 assert.equal(exchange.statusCode,201);
 const cookie=exchange.headers["set-cookie"].split(";")[0];
 const headers={host:"localhost",cookie,origin:"http://localhost","x-atelier-csrf":exchange.json().csrfToken};
 const safe={host:"localhost",cookie};
 const createBody={id:"main",provider:"openai",displayName:"Main channel",apiKey:fakeToken};
 let res=await app.inject({method:"POST",url:"/api/v1/channels",payload:createBody,headers});
 assert.equal(res.statusCode,201,res.body);
 assert.equal(res.body.includes(fakeToken),false);
 assert.equal(res.body.includes("ciphertext"),false);
 assert.equal(res.headers["cache-control"],"no-store");
 const first=res.json().keyVersion;
 res=await app.inject({method:"GET",url:"/api/v1/channels",headers:safe});
 assert.equal(res.statusCode,200);
 assert.equal(res.json().channels[0].keyVersion,first);
 assert.equal(res.body.includes(fakeToken),false);
 assert.equal(res.body.includes("ciphertext"),false);
 res=await app.inject({method:"PATCH",url:"/api/v1/channels/main/credential",
  payload:{apiKey:"wrong-no-csrf",expectedKeyVersion:first},headers:{host:"localhost",cookie,origin:"http://localhost"}});
 assert.equal(res.statusCode,401);
 res=await app.inject({method:"PATCH",url:"/api/v1/channels/main/credential",
  payload:{apiKey:"next-key",expectedKeyVersion:"stale"},headers});
 assert.equal(res.statusCode,409,res.body);
 assert.equal(res.json().code,"credential_version_conflict");
 res=await app.inject({method:"PATCH",url:"/api/v1/channels/main/credential",
  payload:{apiKey:"next-key",expectedKeyVersion:first},headers});
 assert.equal(res.statusCode,200,res.body);
 const next=res.json().keyVersion;
 assert.notEqual(next,first);
 const jobBody={idempotencyKey:"job-old",requestFingerprint:"job-old",executionMode:"poll",
  snapshot:{channelId:"main",secretVersionRef:first,model:"gpt-test"}};
 res=await app.inject({method:"POST",url:"/api/v1/jobs",payload:jobBody,headers});
 assert.equal(res.statusCode,201,res.body);
 const jobId=res.json().id;
 assert.equal(JSON.parse(runtime.db.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(jobId).snapshot_json).secretVersionRef,first);
 res=await app.inject({method:"POST",url:"/api/v1/jobs",
  payload:{...jobBody,idempotencyKey:"wrong",requestFingerprint:"wrong",snapshot:{...jobBody.snapshot,secretVersionRef:"missing"}},headers});
 assert.equal(res.statusCode,404);assert.equal(res.json().code,"credential_missing");
 res=await app.inject({method:"GET",url:"/api/v1/channels/main/versions",headers:safe});
 assert.equal(res.statusCode,200);
 assert.equal(res.json().versions.length,2);
 assert.equal(res.body.includes(fakeToken),false);
 res=await app.inject({method:"POST",url:"/api/v1/channels/main/versions/"+first+"/revoke",
  payload:{},headers});
 assert.equal(res.statusCode,200,res.body);
 assert.equal(res.json().keyVersion,next);
 // Retrying an already-accepted idempotency key still returns its original
 // JobSnapshot even after the pinned credential version was revoked.
 const repeated=await app.inject({method:"POST",url:"/api/v1/jobs",payload:jobBody,headers});
 assert.equal(repeated.statusCode,200,repeated.body);
 assert.equal(repeated.json().id,jobId);
 assert.equal(repeated.json().existing,true);
 res=await app.inject({method:"POST",url:"/api/v1/jobs",
  payload:{...jobBody,idempotencyKey:"revoked",requestFingerprint:"revoked"},headers});
 assert.equal(res.statusCode,409);assert.equal(res.json().code,"credential_revoked");
 assert.equal(runtime.vault.withSecretVersion(next,b=>b.toString("utf8"),{channelId:"main"}),"next-key");
 await runtime.close();closed=true;
 const files=[join(dataDir,"db","atelier.sqlite"),join(dataDir,"db","atelier.sqlite-wal")];
 for(const path of files)if(existsSync(path))
  assert.equal(readFileSync(path).includes(Buffer.from(fakeToken)),false);
 const reopened=openMainDatabase(dataDir);
 try{
  const vault=createCredentialVault({db:reopened,protector:protectorFactory()});
  assert.throws(()=>vault.checkReference(first),/credential_revoked/);
  assert.equal(vault.withSecretVersion(next,b=>b.toString("utf8"),{channelId:"main"}),"next-key");
  assert.equal(JSON.parse(reopened.prepare("SELECT snapshot_json FROM jobs WHERE id=?").get(jobId).snapshot_json).secretVersionRef,first);
 }finally{reopened.close()}
});
