/**
 * React synthetic events bubble through the React owner tree even when Ant Design
 * renders its Select popup in a Portal outside the canvas DOM. Never treat a
 * portaled popup pointer as a canvas/background or node mouse interaction.
 */
export function isNativeDescendantEvent(currentTarget: Pick<Node, "contains">, target: EventTarget | null): boolean {
    return typeof Node !== "undefined" && target instanceof Node && currentTarget.contains(target);
}
