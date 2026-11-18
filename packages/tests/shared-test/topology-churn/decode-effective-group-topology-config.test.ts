import { decodeEffectiveGroupTopologyConfig } from '@shared-test/black-box-runner/topology-churn/decode-effective-group-topology-config.ts';
import { describe, expect, it } from 'vitest';

// The server defaults, as `effective` of the topology-config read serves them for a room without its own settings.
const SERVED = { topologyKind: 'auto', degreeLimit: 5, treeMinSize: 5, meshMinSize: 16, meshParamK: 2 };

describe('decodeEffectiveGroupTopologyConfig', () => {
    it('decodes the effective configuration the topology-config read serves', () => {
        expect(decodeEffectiveGroupTopologyConfig(SERVED).right).toEqual({
            topologyKind: 'auto',
            degreeLimit: 5,
            treeMinSize: 5,
            meshMinSize: 16,
            meshParamK: 2
        });
        expect(decodeEffectiveGroupTopologyConfig({ ...SERVED, topologyKind: 'mesh', meshParamK: 0 }).right)
            .toEqual({ topologyKind: 'mesh', degreeLimit: 5, treeMinSize: 5, meshMinSize: 16, meshParamK: 0 });
    });

    it('refuses a missing or an extra field', () => {
        const missing = { topologyKind: 'auto', degreeLimit: 5, treeMinSize: 5, meshMinSize: 16 };

        expect(decodeEffectiveGroupTopologyConfig(missing).left).toBeTypeOf('string');
        expect(decodeEffectiveGroupTopologyConfig({ ...SERVED, replanning: 'auto' }).left).toBeTypeOf('string');
        expect(decodeEffectiveGroupTopologyConfig(null).left).toBeTypeOf('string');
        expect(decodeEffectiveGroupTopologyConfig([SERVED]).left).toBeTypeOf('string');
    });

    it('refuses an unknown topology kind', () => {
        expect(decodeEffectiveGroupTopologyConfig({ ...SERVED, topologyKind: 'ring' }).left).toBeTypeOf('string');
        expect(decodeEffectiveGroupTopologyConfig({ ...SERVED, topologyKind: null }).left).toBeTypeOf('string');
    });

    it('refuses a fractional or negative number', () => {
        expect(decodeEffectiveGroupTopologyConfig({ ...SERVED, degreeLimit: 4.5 }).left).toBeTypeOf('string');
        expect(decodeEffectiveGroupTopologyConfig({ ...SERVED, treeMinSize: -1 }).left).toBeTypeOf('string');
        expect(decodeEffectiveGroupTopologyConfig({ ...SERVED, meshMinSize: '16' }).left).toBeTypeOf('string');
        expect(decodeEffectiveGroupTopologyConfig({ ...SERVED, meshParamK: Number.NaN }).left).toBeTypeOf('string');
    });
});
