import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {parseEnv} from "node:util";

// Always resolve against the backend's package root, not process.cwd().
// The local .env is ignored by Git and intentionally never sent to the browser.
export const BACKEND_ENV_FILE=fileURLToPath(new URL("../.env",import.meta.url));

/**
 * Load backend-only settings from web/.env.
 * Already supplied process environment values win over .env values.
 * Restrict imported keys to ATELIER_* so untrusted .env contents cannot
 * inject NODE_OPTIONS or alter PATH in the Vite/backend child processes.
 */
export function loadBackendEnv({file=BACKEND_ENV_FILE,env=process.env}={}){
 let contents;
 try{contents=readFileSync(file,"utf8")}
 catch(error){
  if(error?.code==="ENOENT")return {loaded:false,applied:0};
  throw error;
 }
 const values=parseEnv(contents);
 let applied=0;
 for(const [key,value] of Object.entries(values)){
  if(!/^ATELIER_[A-Z0-9_]+$/.test(key) || Object.hasOwn(env,key))continue;
  env[key]=value;
  applied++;
 }
 return {loaded:true,applied};
}
