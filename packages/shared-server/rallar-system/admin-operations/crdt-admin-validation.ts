import type {
  RallarCrdtDocumentLifecycleState,
  RallarCrdtErasureRequest,
} from '@shared/crdt/mod.ts';

const LIFECYCLES = new Set<RallarCrdtDocumentLifecycleState>([
  'active',
  'archived',
  'destroyed',
  'quarantined',
]);

export function readAdminCrdtLifecycle(
  value: unknown,
): RallarCrdtDocumentLifecycleState {
  if (typeof value === 'string' && LIFECYCLES.has(value as RallarCrdtDocumentLifecycleState)) {
    return value as RallarCrdtDocumentLifecycleState;
  }
  throw new Error(`Unsupported CRDT lifecycle: ${String(value)}`);
}

export function readAdminCrdtErasureMode(
  value: unknown,
): RallarCrdtErasureRequest['mode'] {
  if (value === undefined) return 'destroy-document';
  if (value === 'destroy-document' || value === 'redact-payloads') return value;
  throw new Error(`Unsupported CRDT erasure mode: ${String(value)}`);
}
