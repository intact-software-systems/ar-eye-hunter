import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readBranchBody, readFunctionBody } from './authoritative-mutation-source-analysis.ts';

const source = readFileSync(
  'packages/shared-server/rallar-system/topology/replay/create-rtc-topology-work-handler.ts',
  'utf8',
);

it('keeps RTC topology publication and delivery in one reservation transaction', () => {
  const handler = readFunctionBody(source, 'processRtcTopologyWork');
  expectInOrder(handler, [
    'readTopologyMutation(',
    'computeAcceptedRtcTopologyWork(',
    'writeAcceptedRtcTopologyWork(',
  ]);
  expectInOrder(readFunctionBody(source, 'computeAcceptedRtcTopologyWork'), [
    'computeTopologyMutation(',
    'validateTopologyMutation(',
  ]);
  expectInOrder(readFunctionBody(source, 'writeAcceptedRtcTopologyWork'), [
    'writeRtcTopologyPublicationTransaction(',
    'writeTopologyMutation(',
    'writePublicationDelivery(',
  ]);
  expectInOrder(readFunctionBody(source, 'writePublicationDelivery'), [
    'writeRtcTopologyPublicationOutbox(',
    'appendOrValidate(',
  ]);
  expectInOrder(readFunctionBody(source, 'writeRtcTopologyPublicationTransaction'), [
    'runInTransaction(',
    'write(transaction)',
    'finishRtcTopologyReservation(',
  ]);
  expect(source).not.toMatch(/publicationFanout\.publish/);
  expect(source).not.toMatch(/waitForRuntimeStateWriteRetry/);
  expect(source).not.toMatch(/for\s*\([^)]*attempt/);
});

it('validates exact replay before reasserting WS_OUTBOX and completing the reservation', () => {
  const handler = readFunctionBody(source, 'processRtcTopologyWork');
  const replay = readBranchBody(handler, 'if (read.publicationClaim)');
  expectInOrder(replay, ['processLoadedRtcTopologyWork(options, entry, read)', 'return']);
  const loaded = readFunctionBody(source, 'processLoadedRtcTopologyWork');
  expectInOrder(loaded, [
    'computeTopologyMutation(replayInput)',
    'validateTopologyMutation({ ...replayInput, computed })',
    'writeRtcTopologyPublicationTransaction(',
    'writePublicationDelivery(',
  ]);
  expectInOrder(readFunctionBody(source, 'writeRtcTopologyPublicationTransaction'), [
    'write(transaction)',
    'finishRtcTopologyReservation(',
  ]);
  expect(loaded).not.toMatch(/publicationFanout\.publish/);
});

it('keeps the deprecated fanout contract out of production topology ownership', () => {
  expect(source).not.toMatch(/RtcTopologyPublicationFanout|publicationFanout/);
  for (const path of [
    'apps/api-v1/src/runtime/rtc-topology/create-api-rtc-topology-runtime.ts',
    'apps/api-v1/src/middleware.ts',
    'apps/api-v1/src/create-rallar-server.ts',
  ]) {
    expect(readFileSync(path, 'utf8')).not.toMatch(
      /rtcTopologyPublicationFanout|publicationFanout/,
    );
  }
});

function expectInOrder(subject: string, expected: readonly string[]): void {
  let cursor = -1;
  for (const marker of expected) {
    const index = subject.indexOf(marker, cursor + 1);
    expect(index, `missing or out of order: ${marker}`).toBeGreaterThan(cursor);
    cursor = index;
  }
}
