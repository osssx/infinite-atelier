import {execFileSync} from "node:child_process";

/** Windows DPAPI CurrentUser. Secret bytes travel on stdin, never as argv/env.
 * Other platforms fail closed until their OS keychain implementation exists.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
try {
  $ms = [System.IO.MemoryStream]::new()
  [Console]::OpenStandardInput().CopyTo($ms)
  [byte[]]$data = $ms.ToArray()
  [byte[]]$entropy = [Convert]::FromBase64String($args[1])
  if ($args[0] -eq 'protect') {
    [byte[]]$result = [System.Security.Cryptography.ProtectedData]::Protect(
      $data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else {
    [byte[]]$result = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  }
  [Console]::OpenStandardOutput().Write($result, 0, $result.Length)
} catch { exit 1 }
`;
export function createWindowsDpapiProtector({executable="powershell.exe"}={}){
 if(process.platform!=="win32")throw Error("os_credential_protection_unavailable");
 function run(operation,input,context){
  if(!Buffer.isBuffer(input)||!input.length||input.length>32768||
     typeof context!=="string"||context.length>256||!context.startsWith("InfiniteAtelier:v2:"))
   throw Error("invalid_credential_envelope");
  const entropy=Buffer.from(context,"utf8").toString("base64"),copy=Buffer.from(input);
  try{
   // PowerShell treats trailing -Command arguments as script tokens, not $args.
   // An encoded UTF-16LE command embeds ONLY non-secret operation/context.
   const script=SCRIPT.replaceAll("$args[0]","'"+operation+"'")
     .replaceAll("$args[1]","'"+entropy+"'");
   const encoded=Buffer.from(script,"utf16le").toString("base64");
   const result=execFileSync(executable,["-NoProfile","-NonInteractive",
     "-EncodedCommand",encoded],{
      input:copy,encoding:"buffer",windowsHide:true,timeout:15000,maxBuffer:1024*1024,
      stdio:["pipe","pipe","pipe"]});
   if(!Buffer.isBuffer(result)||!result.length)throw Error("empty_dpapi_result");
   return result;
  }catch{
   throw Object.assign(Error("credential_protection_unavailable"),
    {code:"credential_protection_unavailable",statusCode:503});
  }finally{copy.fill(0)}
 }
 return {protect:(input,context)=>run("protect",input,context),
   unprotect:(input,context)=>run("unprotect",input,context)};
}
