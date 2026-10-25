import {randomBytes,timingSafeEqual,createHash} from "node:crypto";
/** Local launcher delivers bootstrap token out-of-band. Never in URL, HTML or Vite variables. */
export function createLocalSessionAuth({sessionLifetimeMs=12*60*60*1000,bootstrapLifetimeMs=5*60*1000,clock=()=>Date.now()}={}){
 const token=()=>randomBytes(32).toString("base64url");
 const hash=value=>createHash("sha256").update(value).digest();
 const equal=(a,b)=>typeof a==="string"&&typeof b==="string"&&timingSafeEqual(hash(a),hash(b));
 let bootstrap=token(),issuedAt=clock();const sessions=new Map();
 function issueBootstrapToken(){bootstrap=token();issuedAt=clock();return bootstrap}
 function issueLocalSession(){
  const id=token(),csrf=token(),expiresAt=clock()+sessionLifetimeMs;
  sessions.set(hash(id).toString("hex"),{csrf,expiresAt});
  return {id,csrf,expiresAt};
 }
 function exchange(provided){
  if(issuedAt===0||!equal(provided,bootstrap)||clock()-issuedAt>bootstrapLifetimeMs)
   throw Object.assign(Error("invalid_bootstrap_token"),{code:"invalid_bootstrap_token",statusCode:401});
  issuedAt=0;bootstrap=token();
  return issueLocalSession();
 }
 function cookies(header){
  const out=new Map();
  if(typeof header==="string")for(const item of header.split(";")){
   const ix=item.indexOf("=");if(ix>0)out.set(item.slice(0,ix).trim(),item.slice(ix+1).trim());
  }
  return out;
 }
 function current(req){
  const id=cookies(req.headers.cookie).get("atelier_session");
  if(!id||id.length>256)return null;
  const key=hash(id).toString("hex"),record=sessions.get(key);
  if(!record)return null;
  if(record.expiresAt<=clock()){sessions.delete(key);return null}
  return {id,...record};
 }
 function authorize(req){
  const record=current(req);if(!record)return false;
  if(["POST","PATCH","PUT","DELETE"].includes(req.method)&&!equal(req.headers["x-atelier-csrf"],record.csrf))return false;
  return true;
 }
 function revoke(req){const record=current(req);if(record)sessions.delete(hash(record.id).toString("hex"))}
 const cookie=(id,{secure=false}={})=>"atelier_session="+id+"; HttpOnly; SameSite=Strict; Path=/; Max-Age="+Math.floor(sessionLifetimeMs/1000)+(secure?"; Secure":"");
 const clearCookie=({secure=false}={})=>"atelier_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+(secure?"; Secure":"");
 return {get bootstrapToken(){return issuedAt?bootstrap:null},issueBootstrapToken,issueLocalSession,exchange,current,authorize,revoke,cookie,clearCookie};
}
