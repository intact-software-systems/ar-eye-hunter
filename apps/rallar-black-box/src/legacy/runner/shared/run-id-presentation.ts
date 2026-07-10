export function shortRunId(value: string): string {
    if (value.length <= 12) {
        return value;
    }
    return value.slice(-10);
}
