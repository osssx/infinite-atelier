import test from "node:test";
import assert from "node:assert/strict";
import {P49B_CASE,reviewP49BCreativeActions} from "./assistant-creative-consistency.mjs";

const stage=P49B_CASE.stages[0];
const card=(title,content)=>({type:"create_text",ref:"n"+title.length,title,content});
const clean=[
 card("小兔嘟嘟","小兔嘟嘟是一只雪白毛色的小兔，穿蓝色斗篷，乐观好奇，在森林里发现遗失的星星并帮助伙伴。"),
 card("兔妈妈","兔妈妈是米白毛色的小兔，穿棕色围裙，温柔耐心，在故事里鼓励小兔独立寻找问题的答案。"),
 card("小龟慢慢","小龟慢慢有橄榄绿色龟壳，性格沉稳细致，善于观察路标，是小兔嘟嘟冒险时的可靠朋友。")
];
test("P4.9b objective checks remain separate from human semantic review",()=>{
 const report=reviewP49BCreativeActions(stage,clean);
 assert.equal(report.objectiveChecksPassed,true);
 assert.equal(report.flags.length,0);
 assert.equal(report.conclusion,"human_review_required");
 assert.equal(report.humanReview.characterAppearance,"pending");
 assert.equal(report.cards.length,3);
 assert.equal(report.cards[0].digest.length,64);
});
test("P4.9b detects missing card, blank body, missing facts and suspicious visual drift",()=>{
 const changed=[{...clean[0],content:"小兔嘟嘟穿红色斗篷，身上没有具体其他设定。"},clean[1]];
 const report=reviewP49BCreativeActions(stage,changed);
 const codes=report.flags.map(f=>f.code);
 assert.ok(codes.includes("node_count_mismatch"));
 assert.ok(codes.includes("expected_title_missing"));
 assert.ok(codes.includes("fact_not_mentioned"));
 assert.ok(codes.includes("rabbit_costume_drift"));
 assert.equal(report.objectiveChecksPassed,false);
 assert.equal(report.humanReview.characterAppearance,"pending");
});
test("P4.9b text reports redact credential-shaped text even in mocked provider drafts",()=>{
 const report=reviewP49BCreativeActions(stage,[
  {...clean[0],content:clean[0].content+" sk-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
  ...clean.slice(1)
 ]);
 assert.doesNotMatch(JSON.stringify(report),/sk-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
 assert.equal(report.humanReview.characterAppearance,"pending");
});
