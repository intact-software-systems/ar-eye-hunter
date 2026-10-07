// @vitest-environment happy-dom

import '../../setup-browser-indexeddb.ts';

import { rallarCrdtBatch } from '@shared/crdt/mod.ts';
import { describe, expect, it } from 'vitest';

import { createTransportDocument, FakeCrdtTransportNetwork } from './rallar-crdt-test-runtime.ts';

describe('the audience of a CRDT document\'s WS sends', () => {
    it('sends an app document to the sender\'s world and a room document to its room', async () => {
        const network = new FakeCrdtTransportNetwork();
        const app = await createTransportDocument({ replicaId: 'tab-a', network, transport: 'ws', scope: { kind: 'app' } });
        await app.applyLocal(rallarCrdtBatch([{ kind: 'map.set', path: [], key: 'title', value: 'App title' }]));
        const appScopes = network.sentScopes('ws');
        const room = await createTransportDocument({ replicaId: 'tab-b', network, transport: 'ws' });
        await room.applyLocal(rallarCrdtBatch([{ kind: 'map.set', path: [], key: 'title', value: 'Room title' }]));

        expect(appScopes.length).toBeGreaterThan(0);
        expect(new Set(appScopes)).toEqual(new Set(['world']));
        expect(new Set(network.sentScopes('ws').slice(appScopes.length))).toEqual(new Set(['room']));
    });
});
