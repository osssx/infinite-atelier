import {createContext,type Dispatch,type SetStateAction} from "react";
export type StoryboardScopeFocus={episodeId:string;sequenceId?:string;shotId?:string};
/** Request guarded navigation from batch results or upstream impact to the editor. */
export const DramaStoryboardNavigationContext=createContext<((focus?:StoryboardScopeFocus)=>void)|null>(null);
export const DramaStoryboardScopeContext=createContext<[StoryboardScopeFocus|null,Dispatch<SetStateAction<StoryboardScopeFocus|null>>]|null>(null);
