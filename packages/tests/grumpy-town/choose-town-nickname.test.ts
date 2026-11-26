import { afterEach, expect, it, vi } from 'vitest';
import { chooseTownNickname } from '../../../apps/grumpy-town/src/online/choose-town-nickname.ts';

afterEach(() => vi.unstubAllGlobals());

it('rejects out-of-range bytes and accepts either end of the nickname list', () => {
    const batches = [[255], [200, 7], [0]];
    vi.stubGlobal('crypto', { getRandomValues(bytes: Uint8Array) {
        bytes.fill(255);
        bytes.set(batches.shift()!);
        return bytes;
    } });
    expect(chooseTownNickname()).toBe('Wobbly Turnip');
    expect(chooseTownNickname()).toBe('Captain Cabbage');
});

it('excludes the displayed nickname before drawing a replacement', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(0) });
    expect(chooseTownNickname('Captain Cabbage')).toBe('Count Crumb');
    expect(chooseTownNickname('Count Crumb')).toBe('Captain Cabbage');
});
