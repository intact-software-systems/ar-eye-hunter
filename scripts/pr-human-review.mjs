import { readValidatorInput } from './pr-human-review/read-review-input.mjs';
import { validateReviewRecord } from './pr-human-review/validate-record.mjs';

runReviewCheck(process.argv.slice(2));

function runReviewCheck(args) {
  const errors = validateReviewRecord(readValidatorInput(args));
  for (const error of errors) {
    console.log(`FAIL: ${error}`);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  } else {
    console.log('PASS: PR Human Review Record v2 evidence is current and complete');
  }
}
