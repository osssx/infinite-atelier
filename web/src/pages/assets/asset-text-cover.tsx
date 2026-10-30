/** Asset covers are previews only. Full text stays in Asset.data.content
 * for editing, searching, copying and the details drawer.
 */
export function assetTextExcerpt(content: string, maxCharacters = 180): string {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) return "";
    // Work only on a bounded prefix even when the asset contains hundreds of KB.
    const prefix = Array.from(content.slice(0, maxCharacters * 2));
    if (prefix.length <= maxCharacters && content.length <= maxCharacters * 2) return content;
    return prefix.slice(0, maxCharacters).join("") + "…";
}

/** Absolutely positioned preview text cannot change the 4:3 card cover height.
 * The line clamp and overflow-wrap also handle newlines and unbroken strings.
 */
export function AssetTextCover({ content, placeholder }: { content: string; placeholder: string }) {
    return (
        <div data-asset-text-cover className="relative aspect-[4/3] w-full overflow-hidden bg-stone-100 text-stone-600 dark:bg-stone-900 dark:text-stone-300">
            <div className="absolute inset-0 flex items-center justify-center overflow-hidden p-5">
                <p className="m-0 line-clamp-5 w-full min-w-0 whitespace-pre-wrap break-words text-center text-sm leading-6 [overflow-wrap:anywhere]">
                    {content ? assetTextExcerpt(content) : placeholder}
                </p>
            </div>
        </div>
    );
}
