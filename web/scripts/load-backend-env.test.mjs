import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {BACKEND_ENV_FILE,loadBackendEnv} from "./load-backend-env.mjs";
import {resolveLocalDataDir} from "../server/backend/runtime.mjs";

function fixture(t,source){
 const folder=mkdtempSync(join(tmpdir(),"atelier-dotenv-"));
 t.after(()=>rmSync(folder,{recursive:true,force:true}));
 const file=join(folder,".env");
 writeFileSync(file,source);
 return {folder,file};
}

test("backend loader resolves web/.env from its script, regardless of cwd",()=>{
 assert.equal(BACKEND_ENV_FILE,resolve(import.meta.dirname,"..",".env"));
});

test("missing .env retains backend defaults and never creates an implicit file",t=>{
 const {folder}=fixture(t,"");
 const target={ATELIER_BACKEND_PORT:"9009"};
 assert.deepEqual(loadBackendEnv({file:join(folder,"missing"),env:target}),{loaded:false,applied:0});
 assert.equal(target.ATELIER_BACKEND_PORT,"9009");
});

test("quoted Windows data path and optional port values are parsed without expanding paths",t=>{
 const {folder,file}=fixture(t,"");
 const configuredRoot=join(folder,"my media");
 writeFileSync(file,'# Backend-only configuration\r\nATELIER_DATA_DIR="'+configuredRoot+'"\r\n'+
  'ATELIER_BACKEND_PORT=8789\r\nATELIER_VITE_PORT=3008\r\n');
 const env={};
 assert.deepEqual(loadBackendEnv({file,env}),{loaded:true,applied:3});
 assert.ok(env.ATELIER_DATA_DIR.endsWith("my media"));
 assert.equal(env.ATELIER_BACKEND_PORT,"8789");
 assert.equal(env.ATELIER_VITE_PORT,"3008");
 assert.equal(resolveLocalDataDir(env.ATELIER_DATA_DIR),resolve(configuredRoot));
});

test("process environment is higher priority than .env, even for an empty preexisting variable",t=>{
 const {file}=fixture(t,"ATELIER_DATA_DIR=D:\\FromFile\nATELIER_BACKEND_PORT=9999\n");
 const env={ATELIER_DATA_DIR:"E:\\FromShell",ATELIER_BACKEND_PORT:""};
 assert.deepEqual(loadBackendEnv({file,env}),{loaded:true,applied:0});
 assert.equal(env.ATELIER_DATA_DIR,"E:\\FromShell");
 assert.equal(env.ATELIER_BACKEND_PORT,"");
});

test("ignore dangerous non-backend variables, including NODE_OPTIONS passed to child processes",t=>{
 const {file}=fixture(t,"NODE_OPTIONS=--import=evil.mjs\nPATH=evil\nATELIER_DATA_DIR=/tmp/atelier-custom\n");
 const env={};
 assert.deepEqual(loadBackendEnv({file,env}),{loaded:true,applied:1});
 assert.deepEqual(env,{ATELIER_DATA_DIR:"/tmp/atelier-custom"});
});

test("changing to an invalid relative data root is rejected before writing a database",t=>{
 const {file}=fixture(t,"ATELIER_DATA_DIR=./data\n");
 const env={};
 loadBackendEnv({file,env});
 assert.throws(()=>resolveLocalDataDir(env.ATELIER_DATA_DIR),/absolute_data_dir_required/);
});

test("a file read error other than missing must not be silently ignored",t=>{
 const {folder}=fixture(t,"");
 assert.throws(()=>loadBackendEnv({file:folder,env:{}}));
});
