/** Shared image ratios for the prompt panel and BBox editor. */
export const IMAGE_SIZE_PRESETS = [
    { ratio: "1:1", width: 1024, height: 1024 },
    { ratio: "3:2", width: 1536, height: 1024 },
    { ratio: "2:3", width: 1024, height: 1536 },
    { ratio: "4:3", width: 1344, height: 1008 },
    { ratio: "3:4", width: 1008, height: 1344 },
    { ratio: "16:9", width: 1536, height: 864 },
    { ratio: "9:16", width: 864, height: 1536 },
] as const;
