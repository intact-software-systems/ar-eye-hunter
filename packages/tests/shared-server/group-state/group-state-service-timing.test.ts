import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const groupStateRoot = 'packages/shared-server/rallar-system/group-state';
const servicePath = `${groupStateRoot}/group-state-service.ts`;
const timingPath = `${groupStateRoot}/group-state-service-timing.ts`;

describe('group-state service timing boundary', () => {
  it('characterizes the predecessor dynamic timing boundary', () => {
    const source = readFileSync(servicePath, 'utf8');

    expect(source).toContain('function withGroupStateServiceTiming(');
    expect(source).toContain('new Proxy(service, {');
    expect(source).toContain('Reflect.get(target, property, receiver)');
    expect(source).toContain('value.apply(target, args)');
  });

  it('requires the future explicit timing owner without dynamic dispatch', () => {
    expect(existsSync(timingPath), timingPath).toBe(true);

    const source = readFileSync(timingPath, 'utf8');
    expect(source).toContain('export function createTimedGroupStateService(');
    expect(source).not.toContain('new Proxy(');
    expect(source).not.toContain('Reflect.get(');
    expect(source).not.toContain('.apply(');
  });
});
