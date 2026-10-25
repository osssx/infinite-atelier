import {createInterface} from "node:readline";

/** Local, out-of-band bootstrap token renewal.
 * Only install on an interactive backend terminal. Never expose a refresh
 * endpoint to an unauthenticated browser, and never persist the raw token.
 */
export function attachBootstrapTokenConsole({
 sessionAuth,input=process.stdin,output=process.stdout,
}={}){
 if(!sessionAuth||typeof sessionAuth.issueBootstrapToken!=="function"||
    !input||!output)throw Error("invalid_bootstrap_console");
 const readline=createInterface({input,crlfDelay:Infinity,terminal:false});
 output.write("Local session tokens expire in 5 minutes and can be used once.\n");
 output.write("Type r and press Enter in this backend terminal to issue a fresh token.\n");
 const onLine=line=>{
  if(line.trim().toLowerCase()!=="r")return;
  const token=sessionAuth.issueBootstrapToken();
  output.write("New one-time backend token (valid for 5 minutes; previous token revoked):\n");
  output.write(token+"\n");
 };
 readline.on("line",onLine);
 return {close(){
  readline.off("line",onLine);
  readline.close();
 }};
}
