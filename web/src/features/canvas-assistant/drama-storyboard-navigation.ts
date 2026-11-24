import {createContext} from "react";
/** Request guarded navigation from batch results to the editor. */
export const DramaStoryboardNavigationContext=createContext<(()=>void)|null>(null);
