const PALETTE = [
    '#ff4d6d',
    '#00c2a8',
    '#ffc857',
    '#7bdff2',
    '#b8f35f',
    '#f08cff',
    '#ff8f3d',
    '#6ea8ff'
];

export function colorForId(id: string): string {
    let hash = 0;
    for (const char of id) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return PALETTE[hash % PALETTE.length];
}
