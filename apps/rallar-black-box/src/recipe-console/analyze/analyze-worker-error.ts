import type { AnalyzeWorkerErrorProjection } from './analyze-worker-contract.ts';

const ANALYZE_WORKER_ERROR_MESSAGES: Record<AnalyzeWorkerErrorProjection['code'], string> = {
    'invalid-request': 'The Analyze worker rejected an invalid request.',
    'invalid-artifact': 'The selected files do not contain a usable distributed artifact.',
    'unusable-artifact': 'The selected artifact does not contain usable distributed-run analysis and snapshots.',
    'unsupported-artifact': 'This artifact belongs in the legacy Shared Test importer.',
    'identity-mismatch': 'The artifact identity does not match the active control selection.',
    'stale-generation': 'A newer Analyze operation replaced this request.',
    'worker-unavailable': 'The Analyze worker is unavailable.',
    'worker-disposed': 'The Analyze worker was disposed.'
};

export function analyzeWorkerError(error: AnalyzeWorkerErrorProjection): Error {
    return new Error(ANALYZE_WORKER_ERROR_MESSAGES[error.code]);
}
