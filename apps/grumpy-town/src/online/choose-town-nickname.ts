const nicknames = [
    'Captain Cabbage',
    'Count Crumb',
    'Dizzy Dumpling',
    'Doctor Drip',
    'Pickle Boots',
    'Professor Puddle',
    'Soggy Biscuit',
    'Wobbly Turnip'
];

/** Every candidate has one accepted byte value. Discard all other samples. */
export function chooseTownNickname(current?: string): string {
    const candidates = nicknames.filter(name => name !== current);
    const samples = new Uint8Array(64);
    for (;;) {
        crypto.getRandomValues(samples);
        const selected = samples.find(sample => sample < candidates.length);
        if (selected !== undefined) return candidates[selected];
    }
}
