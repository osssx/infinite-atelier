import {createHash} from "node:crypto";
import {unzipSync} from "fflate";

const fail=()=>Object.assign(Error("skill_package_integrity_failed"),{
 code:"skill_package_integrity_failed",statusCode:422});
const SIZE=5*1024*1024,FILE=512*1024;
const decoder=new TextDecoder("utf-8",{fatal:true});
const validPath=p=>typeof p==="string"&&p.length>0&&p.length<=240&&
 !p.includes("\\")&&!/[\x00-\x1f\x7f]/.test(p)&&!p.startsWith("/")&&
 !/^(?:[a-zA-Z]:|https?:|file:|data:)/i.test(p)&&
 !p.split("/").some(x=>!x||x==="."||x==="..");
const view16=(v,p)=>v.getUint16(p,true);
const view32=(v,p)=>v.getUint32(p,true);
export function readSkillArchive(bytes){
 if(!bytes||bytes.length>SIZE||bytes.length<22)throw fail();
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){
  if(view32(v,i)===0x06054b50&&i+22+view16(v,i+20)===bytes.length){
   end=i;break;
  }
 }
 if(end<0||view16(v,end+4)||view16(v,end+6))throw fail();
 const n=view16(v,end+10),begin=view32(v,end+16),length=view32(v,end+12);
 if(n!==view16(v,end+8)||n===0||n===65535||n>100||
  begin===0xffffffff||length===0xffffffff||begin+length>end)throw fail();
 const names=new Set(),files=new Set();
 let off=begin,total=0;
 for(let i=0;i<n;i++){
  if(off+46>begin+length||view32(v,off)!==0x02014b50)throw fail();
  const flags=view16(v,off+8),method=view16(v,off+10);
  const compressed=view32(v,off+20),original=view32(v,off+24);
  const pl=view16(v,off+28),ex=view16(v,off+30),comment=view16(v,off+32);
  const target=off+46+pl+ex+comment;
  const mode=view32(v,off+38)>>>16,madeBy=view16(v,off+4)>>>8;
  if(!pl||target>begin+length||compressed===0xffffffff||original===0xffffffff||
    flags&1||flags&0x40||![0,8].includes(method)||
    madeBy===3&&(mode&0xf000)===0xa000)throw fail();
  let name;
  try{name=decoder.decode(bytes.subarray(off+46,off+46+pl))}
  catch{throw fail()}
  const directory=name.endsWith("/");
  const path=directory?name.slice(0,-1):name;
  if(!validPath(path)||names.has(path))throw fail();
  names.add(path);
  if(!directory){
   total+=original;
   if(total>SIZE||original>0&&compressed===0||
     original>Math.max(1024,compressed*200)||
     (/^(?:SKILL\.md|.*\/SKILL\.md)$|\.(?:md|txt|markdown)$/i.test(path))&&original>FILE)
    throw fail();
   files.add(path);
  }
  off=target;
 }
 if(off!==begin+length)throw fail();
 let inflated;
 try{inflated=unzipSync(new Uint8Array(bytes))}
 catch{throw fail()}
 const normalized=new Map();
 const roots=[...files].filter(x=>x==="SKILL.md"||x.endsWith("/SKILL.md"));
 if(roots.length!==1)throw fail();
 const root=roots[0].slice(0,-"SKILL.md".length);
 if(root&&root.slice(0,-1).includes("/"))throw fail();
 for(const path of files){
  if(root&&!path.startsWith(root))throw fail();
  const relative=root?path.slice(root.length):path;
  if(!validPath(relative)||normalized.has(relative))throw fail();
  const body=inflated[path];
  const expected=body&&body.length;
  if(expected===undefined)throw fail();
  normalized.set(relative,Buffer.from(body));
 }
 if(normalized.size!==files.size)throw fail();
 return normalized;
}
export function extractSkillFrontmatter(md){
 const text=md.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n"),lines=text.split("\n");
 if(lines[0]?.trim()!=="---")throw fail();
 const end=lines.findIndex((line,i)=>i>0&&line.trim()==="---");
 if(end<=1||end>120)throw fail();
 const values={};let nested="";
 const decodeValue=raw=>{
  const x=raw.trim();
  if(x.startsWith('"')){try{
    const result=JSON.parse(x);if(typeof result==="string")return result;
   }catch{}throw fail()}
  if(x.startsWith("'")){
   if(!x.endsWith("'")||x.length<2)throw fail();
   return x.slice(1,-1).replace(/''/g,"'");
  }
  return x.replace(/\s+#.*$/,"").trim();
 };
 for(let i=1;i<end;i++){
  const line=lines[i];
  if(!line.trim()||/^\s*#/.test(line))continue;
  if(/^\s/.test(line)){
   if(nested&&nested!=="name"&&nested!=="description")continue;
   throw fail();
  }
  const m=/^([a-zA-Z][\w-]*):(?:\s*(.*))?$/.exec(line);
  if(!m)throw fail();
  nested=m[1];if(Object.hasOwn(values,nested))throw fail();
  let value=m[2]||"";
  if([">","|",">-","|-"].includes(value)){
   const folded=value.startsWith(">"),parts=[];
   while(i+1<end&&(/^\s/.test(lines[i+1])||!lines[i+1].trim())){
    i++;parts.push(lines[i].replace(/^ {1,4}/,""));
   }
   value=parts.join(folded?" ":"\n").trim();
  }
  values[nested]=decodeValue(value);
 }
 const name=values.name??"",description=values.description??"";
 // The directory / manifest id is the stable slug; YAML name is the display title.
 if(!name.trim()||name.length>180||/[\x00-\x1f\x7f]/.test(name)||
  !description.trim()||description.length>1024||
  /[\x00-\x08\x0e-\x1f]/.test(description)||!lines.slice(end+1).join("").trim())
  throw fail();
 return {name,description};
}
const txt=b=>{if(b.length>FILE)throw fail();try{
 const str=decoder.decode(b);if(str.includes("\0"))throw fail();return str;
}catch{throw fail()}};
/** Exactly the front-end hash: sorted normalized paths, path + NUL + byte length
 * + NUL + original unmodified file bytes, SHA-256.
 */
export function calculateNormalizedSkillHash(files){
 const hash=createHash("sha256");let bytes=0;
 for(const [path,content] of [...files].sort(([a],[b])=>a.localeCompare(b))){
  if(!validPath(path))throw fail();
  bytes+=content.length;if(bytes>SIZE)throw fail();
  hash.update(Buffer.from(path+"\0"+content.length+"\0","utf8"));
  hash.update(content);
 }
 return hash.digest("hex");
}
export function verifySkillPackageContent(pkg,archive){
 let files;
 if(archive)files=readSkillArchive(archive);
 else{
  files=new Map([["SKILL.md",Buffer.from(pkg.skillMd,"utf8")]]);
  for(const [path,body] of Object.entries(pkg.resources??{})){
   if(!validPath(path)||typeof body!=="string")throw fail();
   files.set(path,Buffer.from(body,"utf8"));
  }
 }
 if(files.size<1||files.size>100||!files.has("SKILL.md"))throw fail();
 const md=txt(files.get("SKILL.md"));
 if(md!==pkg.skillMd)throw fail();
 const {name,description}=extractSkillFrontmatter(md);
 const references={};
 for(const [path,body] of files){
  if(/^references\/.+\.(?:md|txt|markdown)$/i.test(path)){
   references[path]=txt(body);
  }
 }
 if(Object.keys(references).length!==Object.keys(pkg.resources).length||
  Object.entries(references).some(([k,v])=>pkg.resources[k]!==v))throw fail();
 const paths=[...files.keys()];
 const warnings=[];
 if(paths.some(x=>x.startsWith("scripts/")))
  warnings.push("Script files are inert and cannot be executed in V1");
 if(paths.some(x=>x.startsWith("assets/")))
  warnings.push("Asset files are retained for export, but are not executable or model-readable in V1");
 const resources=paths.filter(x=>/^references\/.+\.(?:md|txt|markdown)$/i.test(x)).sort();
 const hash=calculateNormalizedSkillHash(files);
 const m=pkg.manifest;
 if(typeof m.id!=="string"||m.id.length>80||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.id)||
  m.name!==name||m.description!==description||
  m.hash!==hash||m.version!==hash.slice(0,12)||
  JSON.stringify(m.resources)!==JSON.stringify(resources)||
  JSON.stringify(m.warnings)!==JSON.stringify(warnings))throw fail();
 return hash;
}
