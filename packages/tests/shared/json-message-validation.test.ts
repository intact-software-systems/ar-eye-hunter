import { describe, expect, it, vi } from 'vitest';

import { validateJsonMessageSize } from '@shared/api/json-message-validation.ts';

describe('JSON native wire size validation', () => {
    it.each(['ascii', 'é', 'ࠀ', '😀', '\ud800', '\udfff', '\ud800a', 'a😀é'])('uses exact UTF8 bytes for %j', (value) => {
        const bytes = new TextEncoder().encode(value).length;
        expect(validateJsonMessageSize(value, bytes).right).toBe(value);
        expect(validateJsonMessageSize(value, bytes - 1).left?.code).toBe('oversized');
    });

    it('preserves bounded binary views and measures their span, not their backing buffer', () => {
        const backing = new ArrayBuffer(100);
        const view = new Uint8Array(backing, 20, 4);
        expect(validateJsonMessageSize(view, 4).right).toBe(view);
        expect(validateJsonMessageSize(view, 3).left?.code).toBe('oversized');
        expect(validateJsonMessageSize(backing, 100).right).toBe(backing);
        const blob = new Blob(['é']);
        expect(validateJsonMessageSize(blob, 2).right).toBe(blob);
        expect(validateJsonMessageSize(blob, 1).left?.code).toBe('oversized');
    });

    it('rejects unknown shapes without invoking JSON hooks', () => {
        const toJSON = vi.fn();
        const toString = vi.fn();
        expect(validateJsonMessageSize({ toJSON, toString }, 100).left?.code).toBe('malformed');
        expect(toJSON).not.toHaveBeenCalled();
        expect(toString).not.toHaveBeenCalled();
    });

    it.each([-1, Infinity, NaN, 1.5])('rejects invalid limit %s', (limit) => {
        expect(validateJsonMessageSize('value', limit).left?.code).toBe('malformed');
    });

    it('allows an empty frame at zero bytes and rejects text at that limit', () => {
        expect(validateJsonMessageSize('', 0).right).toBe('');
        expect(validateJsonMessageSize('a', 0).left?.code).toBe('oversized');
    });
});
