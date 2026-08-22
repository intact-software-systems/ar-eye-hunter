export function sameStringArray(
    left: readonly string[],
    right: readonly string[]
): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}
