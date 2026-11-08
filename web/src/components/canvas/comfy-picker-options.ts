export function areComfyPickerOptionsEqual(
  left: readonly { value: string; label: string; disabled?: boolean }[],
  right: readonly { value: string; label: string; disabled?: boolean }[],
) {
  return left.length === right.length && left.every((option, index) => {
    const other = right[index];
    return option.value === other.value && option.label === other.label && Boolean(option.disabled) === Boolean(other.disabled);
  });
}
