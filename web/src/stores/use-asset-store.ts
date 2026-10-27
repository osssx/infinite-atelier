import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import {normalizeAssetCatalog,readBackendAssetCatalog,saveBackendAssetCatalog} from "@/features/backend-sync/asset-catalog-client";


export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

const ASSET_STORE_KEY = "infinite-canvas:asset_store";

// The persisted Asset Library is a single optimistic CAS record in SQLite.
// Never auto-hydrate the legacy browser store and never fall back to LocalForage.
let catalogRevision:number|null=null;
let committedSnapshot="";
let catalogBlocked=false;
let assetWriteQueue: Promise<void> = Promise.resolve();
let lastAssetWriteError: unknown = null;
export async function awaitAssetStorePersistence() {
    await assetWriteQueue;
    if (lastAssetWriteError) throw lastAssetWriteError;
}
export async function importLegacyBrowserAssets():Promise<number>{
    if(!useAssetStore.getState().hydrated)throw Error("asset_catalog_not_ready");
    if(useAssetStore.getState().assets.length)throw Error("asset_catalog_not_empty");
    await awaitAssetStorePersistence();
    const legacy=await localForageStorage.getItem(ASSET_STORE_KEY);
    if(!legacy) return 0;
    const data:unknown=JSON.parse(legacy);
    const assets=(data&&typeof data==="object"&&"state" in data&&
        data.state&&typeof data.state==="object"&&"assets" in data.state)?
        data.state.assets:undefined;
    if(!Array.isArray(assets)||assets.length>5000)throw Error("asset_legacy_invalid");
    if(!assets.length)return 0;
    const portable=await normalizeAssetCatalog(assets as Asset[]);
    const current=await readBackendAssetCatalog();
    if(current.assets.length||current.revision!==catalogRevision)throw Error("asset_catalog_revision_conflict");
    useAssetStore.getState().replaceAssets(portable);
    await awaitAssetStorePersistence();
    return portable.length;
}
const assetStorage: PersistStorage<AssetStore> = {
    getItem: async () => {
        const catalog=await readBackendAssetCatalog(); // fail closed on offline/401
        if(!Number.isSafeInteger(catalog.revision)||!Array.isArray(catalog.assets))
            throw Error("asset_catalog_invalid_response");
        catalogRevision=catalog.revision;
        committedSnapshot=JSON.stringify(catalog.assets);
        catalogBlocked=false;
        return {state:{assets:catalog.assets} as StorageValue<AssetStore>["state"],version:0};
    },
    setItem: (_name,value) => {
        const source=value.state.assets;
        const save=assetWriteQueue.then(async()=>{
            if(catalogBlocked||catalogRevision===null)throw Error("asset_catalog_reload_required");
            const portable=await normalizeAssetCatalog(source);
            const payload=JSON.stringify(portable);
            if(payload!==committedSnapshot){
                try{
                    const saved=await saveBackendAssetCatalog(catalogRevision,portable);
                    if(saved.revision!==catalogRevision+1)throw Error("asset_catalog_invalid_response");
                    catalogRevision=saved.revision;
                    committedSnapshot=payload;
                }catch(error){
                    // Unknown network outcomes and optimistic conflicts must not
                    // be retried as a blind overwrite by the next Zustand write.
                    catalogBlocked=true;throw error;
                }
            }
            lastAssetWriteError=null;
            if(useAssetStore.getState().assets===source&&JSON.stringify(source)!==payload)
                useAssetStore.setState({assets:portable});
        }).catch((error:unknown)=>{
            lastAssetWriteError=error;throw error;
        });
        assetWriteQueue=save.catch(()=>{});
        return save;
    },
    removeItem: async () => { throw Error("asset_catalog_clear_requires_explicit"); },
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                })),
            removeAsset: (id) =>
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                }),
            replaceAssets: (assets) => set({ assets }),
            // CAS deletion is governed by the backend reference ledger/GC.
            // Do not delete historical browser files during staged migration.
            cleanupImages: () => {},
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => (_state,error) => {
                if(error){lastAssetWriteError=error;return}
                useAssetStore.setState({ hydrated: true });
            },
        },
    ),
);
