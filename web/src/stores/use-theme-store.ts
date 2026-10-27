import { create } from "zustand";
import { persist } from "zustand/middleware";
import {awaitThemePersistence,createThemeStorage} from "@/features/backend-sync/ui-theme-persistence";

export type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
    setTheme: (theme: ThemeName) => void;
};

export {awaitThemePersistence};
export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            setTheme: (theme) => set({ theme }),
        }),
        { name: "infinite-canvas:theme_store",storage:createThemeStorage<ThemeStore>() },
    ),
);
