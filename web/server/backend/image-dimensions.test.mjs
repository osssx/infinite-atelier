import test from "node:test";
import assert from "node:assert/strict";
import {rasterDimensions,imageNodeSize} from "./image-dimensions.mjs";

function png(w,h){
 const data=Buffer.alloc(33);
 Buffer.from([137,80,78,71,13,10,26,10]).copy(data,0);
 data.writeUInt32BE(13,8);
 data.write("IHDR",12,"ascii");
 data.writeUInt32BE(w,16);
 data.writeUInt32BE(h,20);
 return data;
}
function jpeg(w,h){
 return Buffer.from([0xff,0xd8,0xff,0xe0,0,4,0,0,0xff,0xc0,0,11,8,h>>8,h&255,w>>8,w&255,3,1,1,1,0xff,0xd9]);
}
function webp(w,h){
 const bytes=Buffer.alloc(30);
 bytes.write("RIFF",0);bytes.write("WEBP",8);bytes.write("VP8X",12);
 bytes.writeUIntLE(w-1,24,3);bytes.writeUIntLE(h-1,27,3);
 return bytes;
}
test("inspect landscape/portrait/square PNG and JPEG and WebP safely",()=>{
 for(const [data,mime] of [[png(768,1344),"image/png"],[jpeg(1344,768),"image/jpeg"],
 [webp(512,768),"image/webp"],[png(1024,1024),"image/png"]]){
  const natural=rasterDimensions(data,mime);
  assert.ok(natural);
  const node=imageNodeSize(natural);
  assert.ok(node.width>=220&&node.height>=220);
  assert.ok(Math.abs(node.width/node.height-natural.width/natural.height)<0.005);
 }
 assert.deepEqual(imageNodeSize({width:768,height:1344}),{width:240,height:420});
 assert.deepEqual(imageNodeSize({width:1344,height:768}),{width:420,height:240});
});
test("JPEG EXIF rotation switches width and height to displayed orientation",()=>{
 const segment=Buffer.alloc(36);
 segment[0]=0xff;segment[1]=0xe1;segment.writeUInt16BE(34,2);
 segment.write("Exif",4,"ascii");
 segment.write("II",10,"ascii");
 segment.writeUInt16LE(42,12);
 segment.writeUInt32LE(8,14);
 segment.writeUInt16LE(1,18);
 segment.writeUInt16LE(0x112,20);
 segment.writeUInt16LE(3,22);
 segment.writeUInt32LE(1,24);
 segment.writeUInt16LE(6,28);
 const base=jpeg(1344,768);
 const rotated=Buffer.concat([base.subarray(0,2),segment,base.subarray(2)]);
 assert.deepEqual(rasterDimensions(rotated,"image/jpeg"),{width:768,height:1344});
 assert.deepEqual(rasterDimensions(jpeg(1344,768),"image/jpeg"),{width:1344,height:768});
});
test("unrecognizable headers, truncated bytes and impossible values fail closed to square fallback",()=>{
 for(const data of [Buffer.alloc(0),Buffer.alloc(16),Buffer.from("not-an-image"),png(0,100),png(1,50000)]){
  assert.equal(rasterDimensions(data,"image/png"),null);
 }
 assert.equal(rasterDimensions(png(100,100),"image/gif"),null);
 assert.deepEqual(imageNodeSize(null),{width:420,height:420});
 assert.deepEqual(imageNodeSize({width:0,height:100}),{width:420,height:420});
});
