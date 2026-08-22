const COLORS = [
    '#f2c14e',
    '#4ecdc4',
    '#ff6b6b',
    '#84cc16',
    '#c084fc',
    '#fb923c'
] as const;

export function colorForId(id: string): string {
    let hash = 0;
    for (const char of id) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return COLORS[hash % COLORS.length];
}
