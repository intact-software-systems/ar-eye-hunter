import { computeSha256, toCanonicalJson } from './canonical-json.mjs';
import { computeGovernanceDecisionId, decodeGovernanceDecisionRequest } from './governance-decision-request.mjs';

export function createGovernanceDecisionReceipt(receiptInput) {
    requireExactKeys(receiptInput.actor, ['login', 'permission'], 'authenticated actor');
    if (
        receiptInput.actor?.permission !== 'admin' ||
        typeof receiptInput.actor.login !== 'string' ||
        receiptInput.actor.login.trim() === ''
    ) {
        throw new Error('authenticated actor permission must be admin');
    }
    const request = decodeGovernanceDecisionRequest(receiptInput.request);
    const transport = validateTransport(receiptInput.transport);
    const result = validateResult(request, receiptInput.result);
    if (
        !Array.isArray(receiptInput.bypassedInvariants) ||
        receiptInput.bypassedInvariants.some(
            (invariant) => typeof invariant !== 'string' || invariant.trim() === ''
        )
    ) {
        throw new Error('bypassed invariants must be non-empty strings');
    }
    const decisionId = computeGovernanceDecisionId(request);
    const stateChanges = receiptInput.stateChanges
        .map(toStateChange)
        .sort((left, right) => compareText(left.path, right.path));
    if (new Set(stateChanges.map((change) => change.path)).size !== stateChanges.length) {
        throw new Error('state change paths must be unique');
    }
    return {
        schemaVersion: 'governance-decision-receipt-v1',
        decisionId,
        requestDigest: decisionId,
        request,
        actor: {
            login: receiptInput.actor.login,
            permission: 'admin'
        },
        transport,
        result,
        bypassedInvariants: [...new Set(receiptInput.bypassedInvariants)].sort(compareText),
        stateChanges
    };
}

function validateTransport(transport) {
    if (transport?.kind === 'local-gh') {
        requireExactKeys(transport, ['kind'], 'local-gh transport');
        return { kind: 'local-gh' };
    }
    if (transport?.kind === 'workflow-dispatch') {
        requireExactKeys(
            transport,
            ['kind', 'runId', 'runAttempt', 'workflowRef', 'workflowSha'],
            'workflow-dispatch transport'
        );
        if (!Number.isSafeInteger(transport.runId) || transport.runId <= 0) {
            throw new Error('workflow-dispatch transport.runId must be a positive integer');
        }
        if (!Number.isSafeInteger(transport.runAttempt) || transport.runAttempt <= 0) {
            throw new Error('workflow-dispatch transport.runAttempt must be a positive integer');
        }
        if (typeof transport.workflowRef !== 'string' || transport.workflowRef.trim() === '') {
            throw new Error('workflow-dispatch transport.workflowRef must be non-empty');
        }
        if (!/^[0-9a-f]{40}$/u.test(transport.workflowSha ?? '')) {
            throw new Error('workflow-dispatch transport.workflowSha must be a Git object ID');
        }
        return { ...transport };
    }
    throw new Error('transport.kind must be local-gh or workflow-dispatch');
}

function validateResult(request, result) {
    const operation = request.operation;
    if (operation === 'gate.accept-deviation') {
        requireExactKeys(
            result,
            ['status', 'underlyingStatus', 'decisionId'],
            'gate.accept-deviation result'
        );
        if (
            result.status !== 'accepted-deviation' ||
            result.underlyingStatus !== 'failed' ||
            result.decisionId !== computeGovernanceDecisionId(request)
        ) {
            throw new Error('gate.accept-deviation result must retain the exact failed conclusion');
        }
        return { ...result };
    }
    if (operation === 'exception.decide') {
        const status = result?.status;
        requireExactKeys(result, ['status', 'decisionId'], 'exception.decide result');
        const expectedStatus = request.target.action === 'approve' ? 'approved' : 'revoked';
        if (status !== expectedStatus || result.decisionId !== computeGovernanceDecisionId(request)) {
            throw new Error('exception.decide result status must be approved or revoked');
        }
        return { status, decisionId: result.decisionId };
    }
    const acceptanceStatus = {
        'plan.repair': 'repaired',
        'plan.cancel': 'not-achieved',
        'plan.supersede': 'transferred',
        'plan.complete': 'admin-attested',
        'plan.quarantine': 'unknown'
    }[operation];
    requireExactKeys(result, ['acceptanceStatus'], `${operation} result`);
    if (result.acceptanceStatus !== acceptanceStatus) {
        throw new Error(`${operation} result must record ${acceptanceStatus}`);
    }
    return { acceptanceStatus };
}

export function serializeGovernanceDecisionReceipt(receipt) {
    return `${toCanonicalJson(receipt)}\n`;
}

export function decodeGovernanceDecisionReceipt(content) {
    let receipt;
    try {
        receipt = JSON.parse(content);
    }
    catch (error) {
        throw new Error(`governance decision receipt contains invalid JSON: ${toError(error).message}`);
    }
    if (serializeGovernanceDecisionReceipt(receipt) !== content) {
        throw new Error('receipt serialization must be canonical JSON plus one newline');
    }
    requireExactKeys(
        receipt,
        [
            'schemaVersion',
            'decisionId',
            'requestDigest',
            'request',
            'actor',
            'transport',
            'result',
            'bypassedInvariants',
            'stateChanges'
        ],
        'receipt'
    );
    if (receipt.schemaVersion !== 'governance-decision-receipt-v1') {
        throw new Error('receipt schemaVersion must be governance-decision-receipt-v1');
    }
    const request = decodeGovernanceDecisionRequest(receipt.request);
    const decisionId = computeGovernanceDecisionId(request);
    if (receipt.requestDigest !== decisionId) {
        throw new Error('receipt requestDigest must equal the canonical request digest');
    }
    if (receipt.decisionId !== decisionId) {
        throw new Error('receipt decisionId must equal the canonical request digest');
    }
    const normalized = createGovernanceDecisionReceipt({
        request,
        actor: receipt.actor,
        transport: receipt.transport,
        result: receipt.result,
        bypassedInvariants: receipt.bypassedInvariants,
        stateChanges: receipt.stateChanges
    });
    if (toCanonicalJson(normalized) !== toCanonicalJson(receipt)) {
        throw new Error('receipt evidence must match the exact normalized receipt contract');
    }
    return normalized;
}

export function toGovernanceDecisionReceiptPath(decisionId) {
    if (typeof decisionId !== 'string' || !/^[0-9a-f]{64}$/u.test(decisionId)) {
        throw new Error('decision ID must be a SHA-256 digest');
    }
    return `governance/decisions/${decisionId}.json`;
}

export function toContentIdentity(content, blobOid) {
    return { blobOid, sha256: computeSha256(content) };
}

function toStateChange(change) {
    requireExactKeys(change, ['path', 'before', 'after'], 'state change');
    if (typeof change?.path !== 'string' || change.path === '') {
        throw new Error('state change path must be a non-empty string');
    }
    if (change.before === null && change.after === null) {
        throw new Error(`state change ${change.path} must change content identity`);
    }
    return {
        path: change.path,
        before: toNullableIdentity(change.before, `${change.path} before`),
        after: toNullableIdentity(change.after, `${change.path} after`)
    };
}

function toNullableIdentity(identity, name) {
    if (identity === null) {
        return null;
    }
    requireExactKeys(identity, ['blobOid', 'sha256'], name);
    if (
        typeof identity?.blobOid !== 'string' ||
        !/^[0-9a-f]{40}$/u.test(identity.blobOid) ||
        typeof identity.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(identity.sha256)
    ) {
        throw new Error(`${name} must contain a Git blob OID and SHA-256 digest`);
    }
    return { blobOid: identity.blobOid, sha256: identity.sha256 };
}

function compareText(left, right) {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function requireExactKeys(value, expectedKeys, name) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${name} must be an object`);
    }
    const actualKeys = Object.keys(value).sort(compareText);
    const sortedExpectedKeys = [...expectedKeys].sort(compareText);
    if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpectedKeys)) {
        throw new Error(`${name} must contain exactly: ${expectedKeys.join(', ')}`);
    }
}

function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
