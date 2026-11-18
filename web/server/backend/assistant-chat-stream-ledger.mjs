// Best-effort in-memory stream ledger for ordinary assistant chat. It is
// intentionally separate from durable Task state: streams are recoverable for
// a short window, while billing/idempotency remains owned by the request turn.
const RETENTION_MS = 5 * 60 * 1000;
const MAX_EVENTS = 4096;
const MAX_TURNS = 128;
export function createAssistantChatStreamLedger({retentionMs=RETENTION_MS,maxTurns=MAX_TURNS,maxActiveTurns=16}={}){
 const turns=new Map();
 const expiredPayloads=new Map();
 const keyOf=(projectId,turnId)=>projectId+"\0"+turnId;
 const prune=()=>{const now=Date.now();for(const [key,turn] of turns){
  if(turn.terminal&&now-turn.updatedAt>retentionMs)turns.delete(key);
 }
 for(const [key,at] of expiredPayloads)if(now-at>retentionMs)expiredPayloads.delete(key);
 };
 const ensure=(projectId,turnId)=>{prune();const key=keyOf(projectId,turnId);let turn=turns.get(key);
  if(!turn){
   if(expiredPayloads.has(key)||expiredPayloads.size>=4096||
    [...turns.values()].filter(candidate=>!candidate.terminal).length>=maxActiveTurns)return null;
   if(turns.size>=maxTurns){
    const oldest=[...turns].filter(([,candidate])=>candidate.terminal)
     .sort(([,left],[,right])=>left.updatedAt-right.updatedAt)[0];
    if(!oldest)return null;
    expiredPayloads.set(oldest[0],oldest[1].updatedAt);
    turns.delete(oldest[0]);
   }
   turn={projectId,turnId,nextSeq:1,events:[],terminal:false,cancelled:false,updatedAt:Date.now()};turns.set(key,turn);
  }
  return turn;
 };
 const append=(projectId,turnId,type,payload={})=>{const turn=turns.get(keyOf(projectId,turnId));
  if(!turn||turn.terminal)return null;
  const event={seq:turn.nextSeq++,type,...payload};turn.events.push(event);
  if(turn.events.length>MAX_EVENTS)turn.events.splice(0,turn.events.length-MAX_EVENTS);
  turn.updatedAt=Date.now();if(["done","error","cancelled"].includes(type))turn.terminal=true;return event;
 };
 return {
  ensure:(projectId,turnId)=>ensure(projectId,turnId),
  append,
  read:(projectId,turnId,after=0)=>{prune();const turn=turns.get(keyOf(projectId,turnId));if(!turn)return null;return {
   turnId,after:Number.isFinite(after)?after:0,events:turn.events.filter(e=>e.seq>after),
   oldestSeq:turn.events[0]?.seq??turn.nextSeq,
   terminal:turn.terminal,cancelled:turn.cancelled,nextSeq:turn.nextSeq
  }},
  cancel:(projectId,turnId)=>{prune();const turn=turns.get(keyOf(projectId,turnId));if(!turn)return null;
   if(!turn.terminal){turn.cancelled=true;append(projectId,turnId,"cancelled",{code:"assistant_cancelled"});}return turn;
  },
  has:(projectId,turnId)=>{prune();return turns.has(keyOf(projectId,turnId));},
  isReplayExpired:(projectId,turnId)=>{prune();return expiredPayloads.has(keyOf(projectId,turnId));}
 };
}
