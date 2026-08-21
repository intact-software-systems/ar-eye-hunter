export type RovingNavigationKey =
    | 'ArrowUp'
    | 'ArrowDown'
    | 'ArrowLeft'
    | 'ArrowRight'
    | 'Home'
    | 'End';

export function nextRovingNavigationIndex(
    current: number,
    key: RovingNavigationKey,
    itemCount: number
): number {
    if (itemCount <= 0) {
        return 0;
    }
    if (key === 'Home') {
        return 0;
    }
    if (key === 'End') {
        return itemCount - 1;
    }

    const normalizedCurrent = ((current % itemCount) + itemCount) % itemCount;
    const delta = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    return (normalizedCurrent + delta + itemCount) % itemCount;
}
