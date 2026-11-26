import {createContext} from "react";
/** Story editor link uses the workspace's own candidate and unsaved-draft gate. */
export const DramaStoryHistoryNavigationContext=createContext<(()=>void)|null>(null);
