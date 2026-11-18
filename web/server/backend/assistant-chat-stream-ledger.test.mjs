import test from "node:test";
import assert from "node:assert/strict";
import {createAssistantChatStreamLedger} from "./assistant-chat-stream-ledger.mjs";

test("ordinary chat stream ledger orders events, keeps active turns, and reports cursor gaps",async()=>{
 const ledger=createAssistantChatStreamLedger({retentionMs:1});
 ledger.ensure("p","t");
 ledger.append("p","t","delta",{text:"a"});
 ledger.append("p","t","done",{answer:"a"});
 const state=ledger.read("p","t",0);assert.deepEqual(state.events.map(e=>e.seq),[1,2]);
 assert.equal(ledger.read("p","missing",0),null);
 ledger.ensure("p","active");ledger.append("p","active","delta",{text:"x"});await new Promise(r=>setTimeout(r,3));
 assert.ok(ledger.has("p","active"));
 const bounded=createAssistantChatStreamLedger({retentionMs:60_000});
 bounded.ensure("p","bounded");
 for(let i=0;i<4097;i++)bounded.append("p","bounded","delta",{text:"x"});
 const replay=bounded.read("p","bounded",0);assert.equal(replay.oldestSeq,2);
});

test("evicting a completed payload admits fresh work without restarting the old turn",()=>{
 const ledger=createAssistantChatStreamLedger({maxTurns:2});
 ledger.ensure("p","old");
 ledger.append("p","old","done");
 ledger.ensure("p","active");
 assert.ok(ledger.ensure("p","new"));
 assert.ok(ledger.has("p","active"));
 assert.equal(ledger.read("p","old"),null);
 assert.equal(ledger.isReplayExpired("p","old"),true);
 assert.equal(ledger.ensure("p","old"),null);
});
