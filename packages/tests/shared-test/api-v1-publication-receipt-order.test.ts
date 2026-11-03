import { expect, it } from 'vitest';

import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

it('lets the recipient acknowledge without waiting for the origin receipt', () => {
    const steps = readApiV1Recipe('tests/api-v1/api-v1-group-publication-grants-cluster.json').steps ?? [];
    const publication = steps.findIndex((step) => step.name === 'alicePublishesOnTheGrantedFeedOnTheTertiary');
    const delivery = steps.findIndex((step) => step.name === 'bobReceivesTheGrantedPublication');
    const acknowledgement = steps.findIndex((step) => step.name === 'bobAcknowledgesTheGrantedPublication');
    expect(publication).toBeGreaterThanOrEqual(0);
    expect(delivery).toBeGreaterThan(publication);
    expect(acknowledgement).toBeGreaterThan(delivery);

    // Alice's admitted receipt can arrive after the receiver's deadline even when Bob got the data promptly.
    // No origin-side observation may block Bob's acknowledgement of that data.
    const originWaits = steps.slice(publication, acknowledgement).filter((step) =>
        step.connection === 'wsAliceTertiary' && step.expect !== undefined
    );
    expect(originWaits).toEqual([]);
    const admitted = steps.findIndex((step) => step.name === 'assertTheAdmittedReceiptExpectsBobAlone');
    const complete = steps.findIndex((step) => step.name === 'assertBobsAckCompletesTheReceipt');
    expect(admitted).toBeGreaterThan(acknowledgement);
    expect(complete).toBeGreaterThan(admitted);
});
