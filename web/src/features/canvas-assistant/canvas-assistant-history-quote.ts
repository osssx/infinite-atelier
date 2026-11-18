import type {HistoryShotRange} from "../../../shared/assistant-history-quote.mjs";

export type HistoryQuoteReference =
 | {mode:"auto"|"selected";sourceRequestId:string;start:number;end:number;digest:string}
 | {mode:"user";text:string;digest:string};
export type HistoryQuoteCandidate=HistoryShotRange&{sourceRequestId:string;sourceTurnMessageId:string;digest:string};
export type UsedHistoryQuote={text:string;label:string;sourceRequestId?:string;sourceTurnMessageId?:string};

export function historyQuoteReference(candidate:HistoryQuoteCandidate,mode:"auto"|"selected"):HistoryQuoteReference{
 const {sourceRequestId,start,end,digest}=candidate;
 return {mode,sourceRequestId,start,end,digest};
}

export function assertHistoryQuoteBudget(text:string){
 if(!text.trim()||new TextEncoder().encode(text).length>4096)throw Error("assistant_history_quote_budget");
}

export async function manualHistoryQuote(text:string):Promise<HistoryQuoteReference>{
 assertHistoryQuoteBudget(text);
 const bytes=new TextEncoder().encode(text);
 const hash=await crypto.subtle.digest("SHA-256",bytes);
 const digest=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("");
 return {mode:"user",text,digest};
}
