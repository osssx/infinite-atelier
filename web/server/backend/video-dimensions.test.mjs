import test from "node:test";
import assert from "node:assert/strict";
import {parseVideoDimensions,readVideoDimensions,videoNodeSize} from "./video-dimensions.mjs";

test("native video metadata sizes portrait, landscape, square and rotated MP4",()=>{
 for(const [w,h,expected] of [
  [768,1344,{width:240,height:420}],
  [1344,768,{width:420,height:240}],
  [1024,1024,{width:420,height:420}]
 ]){
  assert.deepEqual(parseVideoDimensions({streams:[{width:w,height:h}]}),{width:w,height:h});
  assert.deepEqual(videoNodeSize({width:w,height:h}),expected);
 }
 assert.deepEqual(parseVideoDimensions({streams:[{width:1344,height:768,
  side_data_list:[{rotation:-90}]}]}),{width:768,height:1344});
 assert.deepEqual(parseVideoDimensions({streams:[{width:768,height:1344,
  tags:{rotate:"270"}}]}),{width:1344,height:768});
});
test("corrupt media metadata remains a safe fallback without blocking materialization",()=>{
 for(const input of [null,{}, {streams:[]},{streams:[{width:0,height:5}]},
  {streams:[{width:1,height:900000}]},{streams:[{width:Infinity,height:4}]}])
  assert.equal(parseVideoDimensions(input),null);
 assert.deepEqual(videoNodeSize(null),{width:420,height:236});
});
test("ffprobe reads only video streams, uses local file path and catches missing executable",async()=>{
 let calls=0;
 const probe=async(executable,args,options)=>{
  calls++;
  assert.equal(executable,"ffprobe");
  assert.deepEqual(args.slice(-2),["-i","C:/safe-cas/blob"]);
  assert.deepEqual(args.slice(0,4),["-v","error","-select_streams","v:0"]);
  assert.equal(options.maxBuffer,65536);
  assert.ok(options.timeout>0&&options.timeout<=10000);
  return {stdout:JSON.stringify({streams:[{width:1344,height:768,side_data_list:[]}]})};
 };
 assert.deepEqual(await readVideoDimensions("C:/safe-cas/blob","video/mp4",{probe}),{width:1344,height:768});
 assert.equal(calls,1);
 assert.equal(await readVideoDimensions("C:/safe-cas/blob","application/octet-stream",{probe}),null);
 assert.equal(calls,1);
 assert.equal(await readVideoDimensions("C:/safe-cas/blob","video/webm",{probe:async()=>{throw Error("missing ffprobe")}}),null);
 assert.equal(await readVideoDimensions("C:/safe-cas/blob","video/quicktime",{probe:async()=>({stdout:"garbage"})}),null);
});
