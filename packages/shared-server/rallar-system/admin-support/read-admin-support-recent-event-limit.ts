export function readAdminSupportRecentEventLimit(value: number | undefined): number {
    if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
        return 10;
    }
    return Math.min(value, 50);
}
