/** P4.9d: finite, non-sensitive provenance for one Provider POST.
 * Never persist error.message, URL, response body, request headers or causes.
 * The diagnostic describes the OBSERVED failure, not whether a remote model
 * was charged, processed the task or produced an unseen result.
 */
const dnsCodes=new Set(["ENOTFOUND","EAI_AGAIN","EAI_FAIL","ENODATA","model_endpoint_dns_forbidden"]);
const transportCodes=new Set(["ECONNRESET","EPIPE","ECONNABORTED","UND_ERR_SOCKET"]);
const timeoutCodes=new Set(["ETIMEDOUT","ESOCKETTIMEDOUT","ERR_SOCKET_TIMEOUT",
 "UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT"]);
const tlsCodes=new Set(["CERT_HAS_EXPIRED","CERT_NOT_YET_VALID","UNABLE_TO_VERIFY_LEAF_SIGNATURE",
 "SELF_SIGNED_CERT_IN_CHAIN","DEPTH_ZERO_SELF_SIGNED_CERT","ERR_TLS_CERT_ALTNAME_INVALID"]);

function errorCodes(error){
 const codes=[];
 let current=error;
 for(let i=0;i<4&&current&&typeof current==="object";i++){
  if(typeof current.code==="string")codes.push(current.code);
  if(current.name==="TimeoutError")codes.push("TimeoutError");
  current=current.cause;
 }
 return codes;
}
const integerStatus=x=>Number.isInteger(x)&&x>=100&&x<=599?x:null;
const categoryFor=(status,received,codes,deadlineAborted,requestAborted)=>{
 if(requestAborted)return "request_aborted";
 if(deadlineAborted)return "deadline_expired";
 if(received&&status!==null&&status>=500)return "http_server_error";
 if(received&&status===408)return "http_request_timeout";
 if(received&&status===429)return "http_rate_limited";
 if(received&&(status===401||status===403))return "http_auth_rejected";
 if(received&&status!==null&&status>=400)return "http_client_rejected";
 if(received){
  if(codes.includes("assistant_response_invalid"))return "response_parse_invalid";
  if(codes.includes("assistant_response_empty"))return "response_empty";
  if(codes.includes("assistant_response_incomplete"))return "response_incomplete";
  if(codes.includes("assistant_response_blocked"))return "response_filtered";
  if(codes.includes("assistant_response_too_large"))return "response_too_large";
  if(codes.includes("assistant_upstream_timeout")||
    codes.some(c=>timeoutCodes.has(c)))return "response_body_timeout";
  if(codes.includes("assistant_upstream_error"))return "response_provider_error";
  return "response_body_failure";
 }
 if(codes.includes("model_endpoint_dns_forbidden"))return "dns_policy_rejected";
 if(codes.some(c=>dnsCodes.has(c)))return "dns_resolution_failure";
 if(codes.some(c=>tlsCodes.has(c)))return "tls_certificate_rejected";
 if(codes.some(c=>timeoutCodes.has(c))||codes.includes("TimeoutError"))
  return "transport_timeout";
 if(codes.some(c=>transportCodes.has(c)))return "transport_disconnected";
 if(codes.includes("model_endpoint_url_invalid")||codes.includes("model_endpoint_config_invalid"))
  return "endpoint_policy_rejected";
 return "transport_unclassified";
};
export const ASSISTANT_MODEL_DIAGNOSTIC_CATEGORIES=Object.freeze([
 "request_aborted","deadline_expired","http_server_error","http_request_timeout",
 "http_rate_limited","http_auth_rejected","http_client_rejected",
 "response_parse_invalid","response_empty","response_incomplete",
 "response_filtered","response_too_large","response_body_timeout",
 "response_provider_error","response_body_failure","dns_policy_rejected",
 "dns_resolution_failure","tls_certificate_rejected","transport_timeout",
 "transport_disconnected","endpoint_policy_rejected","transport_unclassified"
]);
const validCategories=new Set(ASSISTANT_MODEL_DIAGNOSTIC_CATEGORIES);
export function isSafeAssistantModelDiagnostic(value){
 return value?.version===1&&
  Object.keys(value).every(key=>["version","category","phase","httpStatus"].includes(key))&&
  validCategories.has(value.category)&&
  ["await_response","read_response"].includes(value.phase)&&
  (value.httpStatus===null||integerStatus(value.httpStatus)===value.httpStatus);
}
export function classifyAssistantModelFailure({responseArrived=false,responseStatus=null,
 error=null,deadlineAborted=false,requestAborted=false}={}){
 const httpStatus=integerStatus(responseStatus);
 const codes=errorCodes(error);
 return Object.freeze({
  version:1,
  category:categoryFor(httpStatus,Boolean(responseArrived),codes,
   Boolean(deadlineAborted),Boolean(requestAborted)),
  phase:responseArrived?"read_response":"await_response",
  httpStatus
 });
}
