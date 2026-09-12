import { createCommandRunner } from '../lib/command-runner.mjs';
import { runReviewCiCli } from '../lib/review-ci.mjs';

process.exitCode = runReviewCiCli(
  process.argv.slice(2),
  createCommandRunner(process.cwd()),
  (text) => process.stdout.write(text),
);
