// Vite resolves `?no-inline` imports to an emitted asset URL instead of inlining small files as a
// data URL. The perf fixture depends on that: `hydrateCanvasImages` sends any `data:image/` content
// through `uploadImage`, so an inlined fixture image would trigger one blob write per image node.
declare module "*.svg?no-inline" {
    const url: string;
    export default url;
}
