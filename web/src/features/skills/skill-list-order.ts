/** Present enabled Skills first; retain their existing order within each group. */
export function enabledSkillsFirst<T extends { enabled: boolean }>(skills: readonly T[]): T[] {
    return [...skills].sort((a, b) => Number(b.enabled) - Number(a.enabled));
}
