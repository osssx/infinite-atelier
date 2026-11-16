import test from "node:test";
import assert from "node:assert/strict";
import {classifyAssistantModelFailure,isSafeAssistantModelDiagnostic} from "./assistant-model-call-diagnostics.mjs";

test("P4.9d fixed categories distinguish 5xx, 429, 401, malformed 2xx and body read timeout",()=>{
 const cases=[
  [{responseArrived:true,responseStatus:503,error:{code:"assistant_upstream_error"}},"http_server_error"],
  [{responseArrived:true,responseStatus:504,error:{code:"assistant_upstream_timeout"}},"http_server_error"],
  [{responseArrived:true,responseStatus:429,error:{code:"assistant_upstream_rate_limited"}},"http_rate_limited"],
  [{responseArrived:true,responseStatus:401,error:{code:"assistant_upstream_auth_failed"}},"http_auth_rejected"],
  [{responseArrived:true,responseStatus:422,error:{code:"assistant_upstream_error"}},"http_client_rejected"],
  [{responseArrived:true,responseStatus:200,error:{code:"assistant_response_invalid"}},"response_parse_invalid"],
  [{responseArrived:true,responseStatus:200,error:{code:"assistant_upstream_timeout"}},"response_body_timeout"],
  [{responseArrived:true,responseStatus:200,error:{code:"assistant_response_incomplete"}},"response_incomplete"]
 ];
 for(const [input,want] of cases){
  const result=classifyAssistantModelFailure(input);
  assert.equal(result.category,want);
  assert.equal(result.phase,"read_response");
  assert.equal(result.httpStatus,input.responseStatus);
  assert.equal(isSafeAssistantModelDiagnostic(result),true);
 }
});
test("P4.9d transport diagnoses nested cause codes but never writes arbitrary error/host/credential strings",()=>{
 const malicious=Object.assign(new TypeError("fetch failed sk-testkeyALONGSECRET"),{
  cause:Object.assign(Error("DNS private.internal?api_key=PRIVATE"),{
   code:"ECONNRESET",cause:Object.assign(Error("forged"),{secret:"SHOULD_NOT_LEAK"})
  })
 });
 const res=classifyAssistantModelFailure({error:malicious});
 assert.equal(res.category,"transport_disconnected");
 assert.equal(res.phase,"await_response");
 assert.equal(res.httpStatus,null);
 assert.doesNotMatch(JSON.stringify(res),/sk-testkey|PRIVATE|private.internal|SHOULD_NOT_LEAK/);
 const name=classifyAssistantModelFailure({error:{code:"ENOTFOUND"}});
 assert.equal(name.category,"dns_resolution_failure");
 assert.equal(classifyAssistantModelFailure({error:{code:"CERT_HAS_EXPIRED"}}).category,"tls_certificate_rejected");
 assert.equal(classifyAssistantModelFailure({error:{cause:{code:"UND_ERR_CONNECT_TIMEOUT"}}}).category,"transport_timeout");
 assert.equal(classifyAssistantModelFailure({error:{code:"model_endpoint_dns_forbidden"}}).category,"dns_policy_rejected");
});
test("P4.9d cancellation and client/server timeout classifiers do not invent remote completion",()=>{
 assert.equal(classifyAssistantModelFailure({deadlineAborted:true}).category,"deadline_expired");
 assert.equal(classifyAssistantModelFailure({requestAborted:true,responseArrived:true}).category,"request_aborted");
 assert.equal(classifyAssistantModelFailure({responseArrived:true,responseStatus:408}).category,"http_request_timeout");
 assert.equal(classifyAssistantModelFailure({error:new Error("arbitrary untrusted payload")}).category,"transport_unclassified");
 for(const malicious of [
  {version:1,category:"error:Bearer secret",phase:"await_response",httpStatus:null},
  {version:1,category:"http_server_error",phase:"await_response",httpStatus:200,extra:"secret"}
 ])assert.equal(isSafeAssistantModelDiagnostic(malicious),false);
});
