import test from "node:test";
import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import {createLocalSessionAuth} from "./session.mjs";
import {attachBootstrapTokenConsole} from "./bootstrap-console.mjs";

test("private console regenerates an expired one-time token without restarting or revoking sessions",async()=>{
 let now=1000;
 const auth=createLocalSessionAuth({clock:()=>now,bootstrapLifetimeMs:300,sessionLifetimeMs:5000});
 const oldToken=auth.bootstrapToken;
 const input=new PassThrough(),output=new PassThrough();
 let stdout="";
 output.setEncoding("utf8");
 output.on("data",chunk=>stdout+=chunk);
 const consoleHandle=attachBootstrapTokenConsole({sessionAuth:auth,input,output});
 try{
  now+=301;
  assert.throws(()=>auth.exchange(oldToken),/invalid_bootstrap_token/);
  input.write("ignored\n");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(auth.bootstrapToken,oldToken);
  input.write("r\n");
  await new Promise(resolve=>setImmediate(resolve));
  const newToken=auth.bootstrapToken;
  assert.notEqual(newToken,oldToken);
  assert.ok(stdout.includes(newToken));
  assert.throws(()=>auth.exchange(oldToken),/invalid_bootstrap_token/);
  const session=auth.exchange(newToken);
  assert.equal(auth.bootstrapToken,null);
  const req={method:"GET",headers:{cookie:"atelier_session="+session.id}};
  assert.equal(auth.authorize(req),true);
  assert.throws(()=>auth.exchange(newToken),/invalid_bootstrap_token/);
  input.write(" R \n");
  await new Promise(resolve=>setImmediate(resolve));
  const replacement=auth.bootstrapToken;
  assert.ok(replacement&&replacement!==newToken);
  assert.equal(auth.authorize(req),true,"refresh must not revoke a live session");
  const second=auth.exchange(replacement);
  assert.ok(second.id);
  assert.equal(auth.bootstrapToken,null);
 }finally{consoleHandle.close();input.end();output.end()}
});
