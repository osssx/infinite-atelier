export function readVideoMeta(url: string) {
    return new Promise<{ width?: number; height?: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        let settled = false;
        const finish = (loaded: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            video.removeEventListener("loadedmetadata", onLoaded);
            video.removeEventListener("error", onError);
            const metadata = loaded ? {
                ...(video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : {}),
                ...(Number.isFinite(video.duration) && video.duration > 0 ? { durationMs: Math.round(video.duration * 1000) } : {}),
            } : {};
            video.pause();
            video.removeAttribute("src");
            video.load();
            resolve(metadata);
        };
        const onLoaded = () => finish(true);
        const onError = () => finish(false);
        const timeout = setTimeout(onError, 10_000);
        video.addEventListener("loadedmetadata", onLoaded, { once: true });
        video.addEventListener("error", onError, { once: true });
        video.src = url;
    });
}

export function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        audio.preload = "metadata";
        let settled = false;
        const finish = (loaded: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            audio.removeEventListener("loadedmetadata", onLoaded);
            audio.removeEventListener("error", onError);
            const metadata = loaded && Number.isFinite(audio.duration) && audio.duration > 0 ? { durationMs: Math.round(audio.duration * 1000) } : {};
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
            resolve(metadata);
        };
        const onLoaded = () => finish(true);
        const onError = () => finish(false);
        const timeout = setTimeout(onError, 10_000);
        audio.addEventListener("loadedmetadata", onLoaded, { once: true });
        audio.addEventListener("error", onError, { once: true });
        audio.src = url;
    });
}
