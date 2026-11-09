// Encoded media samples are bundled only into the deliberate perf build, not production.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(webRoot, "perf-media");
const target = resolve(webRoot, "dist", "perf-media");
const files = ["sample-photo.jpg", "sample-video.mp4", "sample-video-poster.jpg", "sample-audio.mp3"];

await mkdir(target, { recursive: true });
for (const file of files) {
    await copyFile(resolve(source, file), resolve(target, file));
}
console.log(`Copied ${files.length} encoded media fixtures for perf build only.`);
