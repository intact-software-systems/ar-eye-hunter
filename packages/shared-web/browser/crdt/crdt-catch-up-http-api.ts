import type { RallarCrdtCatchUpRequestEnvelope, RallarCrdtCatchUpResponseEnvelope } from '@shared/crdt/mod.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiRequestOptions } from '../api/http-request.ts';

type CrdtCatchUpResult =
    | Readonly<{
        ok: true;
        result: RallarCrdtCatchUpResponseEnvelope;
    }>
    | Readonly<{
        ok: false;
        error: string;
    }>;

async function catchUpRallarCrdtDocument(
    request: RallarCrdtCatchUpRequestEnvelope,
    options?: ApiRequestOptions
): Promise<RallarCrdtCatchUpResponseEnvelope> {
    const response = await executeHttpRequest<RallarCrdtCatchUpRequestEnvelope, CrdtCatchUpResult>(
        readApiBaseUrl(),
        '/api/crdt/catch-up',
        'POST',
        request,
        options
    );

    if (!response.ok) {
        throw new Error(response.error);
    }

    return response.result;
}

export const crdtCatchUpHttpApi = Object.freeze({
    catchUpDocument: catchUpRallarCrdtDocument
});
