export type HistoryShotRange={start:number;end:number;text:string;label:string};
export function requestedHistoryShot(request:string):number|null;
export function findHistoryShotRanges(text:string,shot:number):HistoryShotRange[];
