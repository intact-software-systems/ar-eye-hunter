import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const evaluationRoot = path.join(import.meta.dirname, 'rallar-testing', 'evaluations', 'v1');

describe('rallar-testing fresh-agent evaluation contracts', () => {
   it.each([
      ['new-test-creation.json', 5],
      ['obsolete-sequence-test.json', 1],
      ['exactly-once-interaction.json', 1]
   ])('defines %s as a two-variant single-scenario contract', (filename, repetitions) => {
      const evaluation = JSON.parse(
         readFileSync(path.join(evaluationRoot, filename), 'utf8')
      ) as EvaluationContract;

      expect(evaluation.schemaVersion).toBe('rallar-testing-evaluation-v1');
      expect(evaluation.execution).toEqual({
         model: 'gpt-5.6-terra',
         reasoningEffort: 'medium',
         forkTurns: 'none',
         singleShot: true,
         repositoryRootResolution: 'suite-checkout'
      });
      expect(evaluation.repetitionsPerVariant).toBe(repetitions);
      expect(evaluation.variants.map(({ id }) => id)).toEqual([
         'current-guidance',
         'candidate-guidance'
      ]);
      expect(evaluation.scenario.prompt).not.toContain('rallar-testing');
      expect(evaluation.requiredDimensions.length).toBeGreaterThanOrEqual(3);
      expect(evaluation.evidenceContract.rawOutputPolicy).toBe(
         'verbatim-agent-response-separate-from-score-artifact'
      );
   });

   it('routes both variants through the same discovered skill input', () => {
      for (
         const filename of [
            'new-test-creation.json',
            'obsolete-sequence-test.json',
            'exactly-once-interaction.json'
         ]
      ) {
         const evaluation = JSON.parse(
            readFileSync(path.join(evaluationRoot, filename), 'utf8')
         ) as EvaluationContract;

         expect(evaluation.automaticInputs.map(({ id }) => id)).toContain(
            'repository-skill-catalog'
         );
         expect(evaluation.variants.map(({ explicitInputs }) => explicitInputs)).toEqual([
            ['.agents/skills/rallar-testing/SKILL.md'],
            ['.agents/skills/rallar-testing/SKILL.md']
         ]);
      }
   });

   it('reuses the provenance-bound evidence validator', async () => {
      const validator = await import('./general-agent-guidance/evaluation-evidence.mjs');

      expect(typeof validator.validateEvidenceLedger).toBe('function');
      expect(existsRepo('packages/tests/repo/general-agent-guidance/evaluation-evidence.mjs')).toBe(
         true
      );
   });
});

function existsRepo(repositoryPath: string): boolean {
   try {
      readFileSync(path.join(repoRoot, repositoryPath));
      return true;
   }
   catch {
      return false;
   }
}

interface EvaluationContract
{
   readonly schemaVersion: string;
   readonly repetitionsPerVariant: number;
   readonly execution: {
      readonly model: string;
      readonly reasoningEffort: string;
      readonly forkTurns: string;
      readonly singleShot: boolean;
      readonly repositoryRootResolution: string;
   };
   readonly automaticInputs: readonly Readonly<{ id: string; source: string; }>[];
   readonly scenario: { readonly prompt: string; };
   readonly variants: readonly {
      readonly id: string;
      readonly explicitInputs: readonly string[];
   }[];
   readonly requiredDimensions: readonly Readonly<{ id: string; pass: string; }>[];
   readonly evidenceContract: { readonly rawOutputPolicy: string; };
}
