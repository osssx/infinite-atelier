import {open} from "node:fs/promises";

const good=(width,height)=>Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&
 width>0&&height>0&&width<=32768&&height<=32768&&width*height<=268435456?
 {width,height}:null;

/** TIFF/EXIF orientation may rotate JPEG presentation by 90 degrees. Read
 * a bounded IFD0 tag only; never evaluate external offsets outside APP1.
 */
function exifOrientation(data,start,end){
 if(start+14>end||data.toString("ascii",start,start+4)!=="Exif"||data[start+4]!==0||data[start+5]!==0)return 1;
 const root=start+6;
 const little=data.toString("ascii",root,root+2)==="II";
 const big=data.toString("ascii",root,root+2)==="MM";
 if(!little&&!big)return 1;
 const u16=pos=>pos+2<=end?(little?data.readUInt16LE(pos):data.readUInt16BE(pos)):null;
 const u32=pos=>pos+4<=end?(little?data.readUInt32LE(pos):data.readUInt32BE(pos)):null;
 if(u16(root+2)!==42)return 1;
 const pointer=u32(root+4);
 if(pointer===null)return 1;
 const ifd=root+pointer,count=u16(ifd);
 if(count===null||count>256)return 1;
 for(let i=0;i<count;i++){
  const entry=ifd+2+i*12;
  if(entry+12>end)return 1;
  if(u16(entry)===0x112&&u16(entry+2)===3&&u32(entry+4)===1){
   const orientation=u16(entry+8);
   return orientation>=1&&orientation<=8?orientation:1;
  }
 }
 return 1;
}

/** Read only a small prefix of a CAS image, never decode the whole media into
 * memory. Unknown/truncated/invalid headers return null (conservative fallback).
 * JPEG EXIF orientation is handled separately below where available.
 */
export function rasterDimensions(data,mime){
 if(!Buffer.isBuffer(data))return null;
 if(mime==="image/png"){
  if(data.length<24||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
     data.toString("ascii",12,16)!=="IHDR")return null;
  return good(data.readUInt32BE(16),data.readUInt32BE(20));
 }
 if(mime==="image/webp"){
  if(data.length<30||data.toString("ascii",0,4)!=="RIFF"||
   data.toString("ascii",8,12)!=="WEBP")return null;
  const tag=data.toString("ascii",12,16);
  if(tag==="VP8X")return good(1+data.readUIntLE(24,3),1+data.readUIntLE(27,3));
  if(tag==="VP8 "){
   if(data.length<30||data[23]!==0x9d||data[24]!==0x01||data[25]!==0x2a)return null;
   return good(data.readUInt16LE(26)&0x3fff,data.readUInt16LE(28)&0x3fff);
  }
  if(tag==="VP8L"){
   if(data[20]!==0x2f)return null;
   const bits=data.readUInt32LE(21);
   return good((bits&0x3fff)+1,((bits>>>14)&0x3fff)+1);
  }
  return null;
 }
 if(mime==="image/jpeg"){
  if(data.length<4||data[0]!==0xff||data[1]!==0xd8)return null;
  let offset=2,orientation=1;
  while(offset+4<=data.length){
   if(data[offset]!==0xff)return null;
   while(offset<data.length&&data[offset]===0xff)offset++;
   const marker=data[offset++];
   if(marker===0xd9||marker===0xda)return null;
   if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
   if(offset+2>data.length)return null;
   const length=data.readUInt16BE(offset);
   if(length<2||offset+length>data.length)return null;
   if(marker===0xe1&&orientation===1)orientation=exifOrientation(data,offset+2,offset+length);
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
    if(length<7)return null;
    const height=data.readUInt16BE(offset+3),width=data.readUInt16BE(offset+5);
    return orientation>=5&&orientation<=8?good(height,width):good(width,height);
   }
   offset+=length;
  }
 }
 return null;
}

export async function readRasterImageDimensions(path,mime){
 if(!["image/png","image/jpeg","image/webp"].includes(mime))return null;
 const file=await open(path,"r");
 try{
  const bytes=Buffer.alloc(256*1024);
  const {bytesRead}=await file.read(bytes,0,bytes.length,0);
  return rasterDimensions(bytes.subarray(0,bytesRead),mime);
 }finally{await file.close()}
}

/** Preserve actual proportions with a maximum default edge and sufficient
 * area for the existing image-node resize handles (minimum 220px side).
 */
export function imageNodeSize(dimensions,{maxEdge=420,minSide=220}={}){
 if(!dimensions)return {width:maxEdge,height:maxEdge};
 const {width,height}=dimensions;
 if(!good(width,height))return {width:maxEdge,height:maxEdge};
 const scale=Math.max(maxEdge/Math.max(width,height),minSide/Math.min(width,height));
 return {width:Math.round(width*scale),height:Math.round(height*scale)};
}
