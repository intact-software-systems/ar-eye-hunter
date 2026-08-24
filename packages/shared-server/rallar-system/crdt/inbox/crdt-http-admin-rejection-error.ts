import type { JsonWireObject } from '../../protocol/json-wire-identity.ts';

export class CrdtHttpAdminRejectionError extends Error {
    readonly code = 'crdt-admin-mutation-rejected';
    readonly status: number;
    readonly details: JsonWireObject;

    constructor(reasonCode: string) {
        super(`CRDT admin mutation rejected: ${reasonCode}`);
        this.status = toCrdtHttpAdminRejectionStatus(reasonCode);
        this.details = { reasonCode };
        this.name = 'CrdtHttpAdminRejectionError';
    }
}

function toCrdtHttpAdminRejectionStatus(reasonCode: string): number {
    if (reasonCode.startsWith('authentication-')) {
        return 401;
    }
    if (reasonCode === 'document-not-found') {
        return 404;
    }
    if (reasonCode.startsWith('authorization-') || reasonCode === 'feature-disabled') {
        return 403;
    }
    return 409;
}
