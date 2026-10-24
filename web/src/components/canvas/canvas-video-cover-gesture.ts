/** Canvas drag begins at >3 CSS pixels. Cover clicks must use the same
 * threshold so a drag never starts playback at mouseup.
 */
export type VideoCoverPress = { startX:number; startY:number; dragged:boolean };
export function videoCoverPressDragged(press:VideoCoverPress | null, x:number, y:number):boolean {
    if(!press)return false;
    return press.dragged || Math.abs(x-press.startX)>3 || Math.abs(y-press.startY)>3;
}

/** Keyboard clicks have detail=0, while mouse clicks only play if the poster was not dragged. */
export function shouldPlayVideoCoverClick(
    press:VideoCoverPress | null, click: { detail:number; clientX:number; clientY:number },
):boolean {
    return click.detail === 0 || (press !== null && !videoCoverPressDragged(press,click.clientX,click.clientY));
}

