import { readSession } from '@shared/api/auth.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import {
  readClientStateRevision,
  readGroupCausalRevision,
} from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
  parseAuthoritativeClientSnapshot,
  parseAuthoritativeGroupSnapshot,
} from '@shared/api/authoritative-state-validation.ts';
import type {
  ClientStateSnapshotReadOptions,
  GroupStateSnapshotReadOptions,
  StateSnapshotReadSource,
} from '@shared/api/state-snapshot-read.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { ApiHttpError } from '../api/http-error.ts';
import type { ApiRequestOptions } from '../api/http-request.ts';
import { emitBrowserStateReadDiagnostic } from './diagnostics.ts';

export type ReadStateClientSnapshotOptions =
  & ApiRequestOptions
  & ClientStateSnapshotReadOptions;

export type ReadStateGroupSnapshotOptions =
  & ApiRequestOptions
  & GroupStateSnapshotReadOptions;

export interface StateClientSnapshotRead {
  readonly snapshot: ClientSnapshot;
  readonly source: StateSnapshotReadSource;
  readonly stateRevision: number;
}

export interface StateGroupSnapshotRead {
  readonly snapshot: GroupSnapshot;
  readonly source: StateSnapshotReadSource;
  readonly groupRevision: number;
  readonly presenceRevision: number;
}

interface PointReadInput<T> {
  readonly feature: 'client' | 'group';
  readonly path: string;
  readonly options: ApiRequestOptions;
  readonly readResult: (
    serialized: string,
    source: StateSnapshotReadSource,
    headers: Headers,
  ) => T;
}

interface PointPathInput {
  readonly scope: StateScope;
  readonly collection: 'clients' | 'groups';
  readonly id: string;
  readonly floors: readonly (readonly [name: string, value: number | undefined])[];
}

interface EmitDiagnosticInput {
  readonly feature: 'client' | 'group';
  readonly result: 'found' | 'not-found' | 'error';
  readonly startedAt: number;
  readonly source?: StateSnapshotReadSource;
}

export async function readStateClientSnapshot(
  principalId: string,
  scope: StateScope,
  options: ReadStateClientSnapshotOptions = {},
): Promise<StateClientSnapshotRead> {
  return await readPointSnapshot({
    feature: 'client',
    path: pointPath({
      scope,
      collection: 'clients',
      id: principalId,
      floors: [['minStateRevision', options.minStateRevision]],
    }),
    options,
    readResult: (serialized, source, headers) => {
      const snapshot = parseAuthoritativeClientSnapshot(serialized, scope);
      if (snapshot.principal.principalId !== principalId) {
        throw new Error('Client snapshot response principal does not match the request.');
      }
      const stateRevision = readRevisionHeader(headers, 'rallar-state-revision');
      if (stateRevision !== readClientStateRevision(snapshot)) {
        throw new Error(
          'Client snapshot response header revision does not match the body.',
        );
      }
      return { snapshot, source, stateRevision };
    },
  });
}

export async function readStateGroupSnapshot(
  groupId: string,
  scope: StateScope,
  options: ReadStateGroupSnapshotOptions = {},
): Promise<StateGroupSnapshotRead> {
  return await readPointSnapshot({
    feature: 'group',
    path: pointPath({
      scope,
      collection: 'groups',
      id: groupId,
      floors: [
        ['minGroupRevision', options.minCausalRevision?.groupRevision],
        ['minPresenceRevision', options.minCausalRevision?.presenceRevision],
      ],
    }),
    options,
    readResult: (serialized, source, headers) => {
      const snapshot = parseAuthoritativeGroupSnapshot(serialized, scope);
      if (snapshot.group.groupId !== groupId) {
        throw new Error('Group snapshot response group does not match the request.');
      }
      const groupRevision = readRevisionHeader(headers, 'rallar-group-revision');
      const presenceRevision = readRevisionHeader(headers, 'rallar-presence-revision');
      const bodyRevision = readGroupCausalRevision(snapshot);
      if (
        groupRevision !== bodyRevision.groupRevision ||
        presenceRevision !== bodyRevision.presenceRevision
      ) {
        throw new Error('Group snapshot response header revisions do not match the body.');
      }
      return { snapshot, source, groupRevision, presenceRevision };
    },
  });
}

async function readPointSnapshot<T>(input: PointReadInput<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const headers = new Headers({ 'content-type': 'application/json' });
    const session = input.options.authSession === undefined
      ? readSession()
      : input.options.authSession;
    if (session) {
      headers.set('authorization', `Bearer ${session.accessToken}`);
      headers.set('x-client-id', session.clientId);
    }
    const response = await fetch(`${readApiBaseUrl()}${input.path}`, {
      method: 'GET',
      headers,
      signal: input.options.signal,
    });
    if (!response.ok) {
      throw new ApiHttpError(
        'GET',
        input.path,
        response.status,
        await readErrorBody(response),
        response.headers,
      );
    }
    const source = readSource(response.headers);
    assertNoStore(response.headers);
    const result = input.readResult(await response.text(), source, response.headers);
    emitDiagnostic({ feature: input.feature, result: 'found', startedAt, source });
    return result;
  } catch (error) {
    emitDiagnostic({
      feature: input.feature,
      result: error instanceof ApiHttpError && error.status === 404 ? 'not-found' : 'error',
      startedAt,
    });
    throw error;
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function emitDiagnostic(input: EmitDiagnosticInput): void {
  emitBrowserStateReadDiagnostic({
    name: 'rallar.browser.state-read',
    feature: input.feature,
    operation: 'point',
    result: input.result,
    source: input.source,
    durationMs: performance.now() - input.startedAt,
  });
}

function pointPath(input: PointPathInput): string {
  const query = new URLSearchParams();
  for (const [name, value] of input.floors) {
    if (value !== undefined) {
      query.set(name, canonicalRevision(value));
    }
  }
  const path = `/api/state/apps/${encodeURIComponent(input.scope.applicationId)}` +
    `/workspaces/${encodeURIComponent(input.scope.workspaceId)}` +
    `/${input.collection}/${encodeURIComponent(input.id)}`;
  return query.size === 0 ? path : `${path}?${query}`;
}

function canonicalRevision(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('State revision floors must be non-negative safe integers.');
  }
  return String(value);
}

function readSource(headers: Headers): StateSnapshotReadSource {
  const source = headers.get('rallar-state-source');
  if (source !== 'cache' && source !== 'durable') {
    throw new Error('State snapshot response has an invalid or missing source header.');
  }
  return source;
}

function readRevisionHeader(headers: Headers, name: string): number {
  const value = headers.get(name);
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`State snapshot response has an invalid or missing ${name} header.`);
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw new Error(`State snapshot response has an unsafe ${name} header.`);
  }
  return revision;
}

function assertNoStore(headers: Headers): void {
  const noStore = headers.get('cache-control')?.toLowerCase().split(',')
    .some((directive) => directive.trim() === 'no-store');
  if (!noStore) {
    throw new Error('State snapshot response is missing Cache-Control: no-store.');
  }
}
