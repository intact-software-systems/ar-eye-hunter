import type { StateScope } from '../../api/state-types.ts';

export interface ALBrowserLockOptions {
    readonly mode: 'exclusive';
    /** Abandons the request while it still waits; absent, the request waits until it is granted. */
    readonly signal?: AbortSignal;
}

/**
 * The Web Locks port every cross-context lock of ALM is a name on, read from `navigator.locks`. Node and
 * Deno expose a process-wide one too; only a browser without the API, or an explicit `undefined`, has none.
 */
export interface ALBrowserLocks {
    /** Holds the named exclusive lock until the single callback invocation settles. */
    request<T>(name: string, options: ALBrowserLockOptions, callback: () => Promise<T>): Promise<T>;
}

export function readALBrowserLocks(): ALBrowserLocks | undefined {
    return typeof globalThis.navigator?.locks?.request === 'function' ? globalThis.navigator.locks : undefined;
}

/** Serializes one sender's IndexedDB commits across the tabs of a browser. */
export function toALOutboundCommitLockName(senderId: string): string {
    return `rallar:al-outbound-commit:${senderId}`;
}

/**
 * Held by the one connect that drains its session's durable work in one scope. Each part of the scope
 * is URI-encoded, as the scope's database name is, so an id with a colon cannot alias another scope.
 */
export function toALDurableOwnerLockName(scope: StateScope, sessionId: string): string {
    const applicationId = encodeURIComponent(scope.applicationId);
    return `rallar:al-durable-owner:${applicationId}:${encodeURIComponent(scope.workspaceId)}:${sessionId}`;
}
