type VideoPlayer = { prepare: () => () => Promise<void> };
const players = new Map<string, VideoPlayer>();

export function registerCanvasVideoPlayer(nodeId: string, player: VideoPlayer) {
    players.set(nodeId, player);
    return () => { if (players.get(nodeId) === player) players.delete(nodeId); };
}

/** Reset every player before starting any, preserving the menu click's user activation. */
export function playCanvasVideosFromStart(nodeIds: readonly string[]) {
    const starts = nodeIds.flatMap((id) => {
        const player = players.get(id);
        return player ? [player.prepare()] : [];
    });
    return Promise.allSettled(starts.map((start) => start()));
}
