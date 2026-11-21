import test from "node:test";
import assert from "node:assert/strict";
import {buildDramaStagePrompt, validateDramaPipelineSnapshot, normalizeDramaPipelineSnapshot} from "./drama-pipeline.mjs";

const base = {
  version: 1, stage: "first_frames", revision: 2,
  assets: [
    {id: "hero", kind: "character", name: "主角", description: "确认的角色外观", sourceRefs: ["p1"], variants: [{id: "hero-day", name: "日常造型", description: "蓝色外套"}]},
    {id: "bridge", kind: "scene", name: "石桥", description: "雨中的石桥", sourceRefs: ["p2"], variants: [{id: "bridge-rain", name: "暴雨", description: "湿滑桥面"}]},
    {id: "star", kind: "prop", name: "星星", description: "发光星星", sourceRefs: ["p3"]},
  ],
  references: [
    {assetId: "hero", variantId: "hero-day", imageStorageKey: "cas:hero", requiredForRendering: true},
    {assetId: "bridge", variantId: "bridge-rain", imageStorageKey: "cas:bridge", requiredForRendering: true},
    {assetId: "star", imageStorageKey: "cas:star", requiredForRendering: true},
  ],
  shots: [{id: "shot-1", episodeId: "ep-1", order: 0, description: "主角在暴雨石桥举起星星", characterVariantIds: ["hero-day"], sceneId: "bridge", sceneVariantId: "bridge-rain", propIds: ["star"], keyPropIds: ["star"]}],
};

test("accepts a complete first-frame snapshot with character, scene variant and key prop", () => {
  assert.deepEqual(validateDramaPipelineSnapshot(base), {valid: true, errors: []});
  assert.deepEqual(normalizeDramaPipelineSnapshot(base), base);
});

test("reports missing key prop reference without rejecting the editable storyboard", () => {
  const snapshot = structuredClone(base);
  snapshot.references = snapshot.references.filter(item => item.assetId !== "star");
  const result = validateDramaPipelineSnapshot(snapshot);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "render_reference_missing" && error.id === "star"));
});

test("supports multiple CAS images and treats an explicitly emptied collection as missing", () => {
  const snapshot = structuredClone(base);
  const keys = ["cas:" + "a".repeat(64), "cas:" + "b".repeat(64)];
  snapshot.references[0].imageStorageKeys = keys;
  assert.equal(validateDramaPipelineSnapshot(snapshot).valid, true);
  snapshot.references[0].imageStorageKeys = [keys[0], keys[0]];
  assert.equal(validateDramaPipelineSnapshot(snapshot).errors[0].code, "asset_reference_invalid");
  snapshot.references[0].imageStorageKeys = [];
  assert.equal(validateDramaPipelineSnapshot(snapshot).errors[0].code, "render_reference_missing");
});

test("rejects a prop accidentally used as a scene or an unlinked key prop", () => {
  const snapshot = structuredClone(base);
  snapshot.shots[0].sceneId = "star";
  snapshot.shots[0].keyPropIds = ["hero"];
  const result = validateDramaPipelineSnapshot(snapshot);
  assert.ok(result.errors.some(error => error.code === "shot_scene_invalid"));
  assert.ok(result.errors.some(error => error.code === "shot_key_prop_unlinked"));
});

test("reports malformed assets and shots without dereferencing invalid fields", () => {
  const snapshot = structuredClone(base);
  snapshot.assets[0].variants = [null];
  assert.equal(validateDramaPipelineSnapshot(snapshot).errors[0].code, "asset_variant_invalid");
  snapshot.assets = base.assets;
  snapshot.shots = [null];
  assert.equal(validateDramaPipelineSnapshot(snapshot).errors[0].code, "shot_invalid");
});

test("rejects a scene variant belonging to a different scene", () => {
  const snapshot = structuredClone(base);
  snapshot.assets.push({id: "garden", kind: "scene", name: "花园", description: "花园", sourceRefs: ["p2"]});
  snapshot.shots[0].sceneId = "garden";
  assert.ok(validateDramaPipelineSnapshot(snapshot).errors.some(error => error.code === "shot_scene_variant_invalid"));
});

test("generation prompt supplies stable source anchors and the requested output shape", () => {
  const prompt = buildDramaStagePrompt({stage: "episodes", sourceText: "第一行\n\n第三行", targetEpisodes: 2});
  assert.match(prompt, /恰好 2 集/);
  assert.match(prompt, /"episodes"/);
  assert.match(prompt, /\[p1\] 第一行/);
  assert.match(prompt, /\[p3\] 第三行/);
});


test("generation uses frozen stable paragraph IDs instead of line-number aliases",()=>{
 const prompt=buildDramaStagePrompt({stage:"storyboard",sourceText:"Edited source",sourceParagraphs:[{id:"paragraph-stable",text:"Edited source"}]});
 assert.match(prompt,/\[paragraph-stable\] Edited source/);
 assert.doesNotMatch(prompt,/\[p1\] Edited source/);
 assert.match(prompt,/不得重编号/);
});
