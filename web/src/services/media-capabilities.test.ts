import {describe,expect,it} from "vitest";
import {isMediaCapabilities,resolveMediaCapabilities,supportedMediaModes,validateMediaRequest,type MediaCapabilities} from "./media-capabilities";

describe("media capability v1",()=>{
 it("keeps absent declarations on the legacy compatibility path",()=>{
  const resolved=resolveMediaCapabilities({}, {kind:"video",supportedModes:["text_to_video"]});
  expect(resolved.source).toBe("legacy_compatibility");
  expect(validateMediaRequest({mode:"unsupported"},resolved)).toEqual([]);
 });
 it("intersects explicit modes with executor support and checks roles/counts",()=>{
  const cap:MediaCapabilities={schemaVersion:1,kind:"video",defaultMode:"first_frame",modes:[
   {id:"first_frame",enabled:true,inputs:[{role:"first_frame",kind:"image",minItems:1,maxItems:1}],parameters:[]},
   {id:"last_frame",enabled:true,inputs:[{role:"last_frame",kind:"image",minItems:1,maxItems:1}],parameters:[]},
  ]};
  const resolved=resolveMediaCapabilities({mediaCapabilities:cap},{kind:"video",supportedModes:["first_frame"]});
  expect(resolved.modes.map(mode=>mode.id)).toEqual(["first_frame"]);
  expect(resolved.unavailable).toEqual([{code:"executor_mode_unsupported",mode:"last_frame"}]);
  expect(validateMediaRequest({mode:"first_frame",references:[]},resolved)[0]?.code).toBe("media_input_count");
  expect(validateMediaRequest({mode:"last_frame",references:[]},resolved)[0]?.code).toBe("media_mode_unavailable");
 });
 it("rejects unknown nested fields and invalid enum defaults",()=>{
  const base={schemaVersion:1,kind:"image",modes:[{id:"text_to_image",enabled:true,inputs:[],parameters:[]}]};
  expect(isMediaCapabilities({...base,modes:[{...base.modes[0],parameters:[{id:"count",mode:"adjustable",type:"enum",values:[1,2],defaultValue:3}]}]})).toBe(false);
  expect(isMediaCapabilities({...base,modes:[{...base.modes[0],parameters:[{id:"count",mode:"adjustable",type:"number",nested:{script:"bad"}}]}]})).toBe(false);
  expect(isMediaCapabilities({schemaVersion:1,kind:"__proto__",modes:[]})).toBe(false);
 });
 it("structural validation defers file metadata checks but backend metadata validation stays strict",()=>{
  const cap:MediaCapabilities={schemaVersion:1,kind:"video",defaultMode:"omni_reference",modes:[{id:"omni_reference",enabled:true,inputs:[{role:"reference_video",kind:"video",minItems:0,maxItems:1,maxDurationSeconds:15,mimeTypes:["video/mp4"]}],parameters:[]}]};
  const resolved=resolveMediaCapabilities({mediaCapabilities:cap},{kind:"video"});
  const ref={role:"reference_video",kind:"video"};
  expect(validateMediaRequest({mode:"omni_reference",references:[ref]},resolved,{phase:"structure"})).toEqual([]);
  expect(validateMediaRequest({mode:"omni_reference",references:[]},resolved,{phase:"structure"})[0]?.code).toBe("media_reference_required");
  expect(validateMediaRequest({mode:"omni_reference",references:[ref]},resolved).map(e=>e.code)).toEqual(["media_input_format","media_input_duration"]);
  expect(validateMediaRequest({mode:"omni_reference",references:[{...ref,mimeType:"video/mp4",durationMs:16000}]},resolved)[0]?.code).toBe("media_input_duration");
  expect(validateMediaRequest({mode:"omni_reference",references:[{...ref,mimeType:"video/mp4",durationMs:5000}]},resolved)).toEqual([]);
 });
 it("checks runtime parameter type, finite range, and step with the shared executor map",()=>{
  const cap:MediaCapabilities={schemaVersion:1,kind:"video",defaultMode:"text_to_video",modes:[{id:"text_to_video",enabled:true,inputs:[],parameters:[{id:"duration_seconds",mode:"adjustable",type:"number",min:4,max:15,step:1}]}]};
  const resolved=resolveMediaCapabilities({mediaCapabilities:cap},{kind:"video",supportedModes:supportedMediaModes({provider:"volcengine_ark",kind:"video"})});
  expect(validateMediaRequest({mode:"text_to_video",parameters:{duration_seconds:"6"}},resolved)[0]?.code).toBe("media_parameter_invalid");
  expect(validateMediaRequest({mode:"text_to_video",parameters:{duration_seconds:16}},resolved)[0]?.code).toBe("media_parameter_invalid");
  expect(supportedMediaModes({provider:"google_gemini",kind:"image"})).toEqual(["text_to_image","reference_edit"]);
  expect(supportedMediaModes({provider:"openai",kind:"video",customScript:true})).toContain("first_last_frame");
 });
});
