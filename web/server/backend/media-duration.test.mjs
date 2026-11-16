import test from "node:test";
import assert from "node:assert/strict";
import {parseMediaDurationMs,readMediaDurationMs} from "./media-duration.mjs";

test("duration parser accepts finite local probe metadata and rejects missing or invalid values",()=>{
 assert.equal(parseMediaDurationMs({format:{duration:"4.25"}}),4250);
 assert.equal(parseMediaDurationMs({streams:[{duration:"2.1"},{duration:"4.2"}]}),4200);
 assert.equal(parseMediaDurationMs({format:{duration:"NaN"},streams:[]}),null);
});
test("media duration probe is local-file only and bounded",async()=>{
 let calls=0;
 const probe=async(_exe,args,options)=>{calls++;assert.deepEqual(args.slice(0,5),["-v","error","-protocol_whitelist","file","-show_streams"]);assert.equal(options.timeout,8000);return {stdout:JSON.stringify({format:{duration:"3"}})}};
 assert.equal(await readMediaDurationMs("C:/cas/hash.mp4","video/mp4",{probe}),3000);
 assert.equal(await readMediaDurationMs("https://example.test/video.mp4","video/mp4",{probe}),null);
 assert.equal(calls,1);
});
