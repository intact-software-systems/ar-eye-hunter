import {
    canonicalRallarAiJson,
    hashRallarAiJson
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

describe('RallarAI JSON hashing', () => {
    it('canonicalizes and hashes JSON independent of object property order', () => {
        expect(canonicalRallarAiJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
        expect(hashRallarAiJson({ b: 2, a: 1 })).toBe(
            hashRallarAiJson({ a: 1, b: 2 })
        );
    });
});
