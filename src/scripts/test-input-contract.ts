// Offline verification of the agent INPUT contract (no API key needed).
//
//   npm run test:input-contract
//
// Runs actionableInputs() against the three captured/synthesized samples and asserts
// the act-on rule: baseline `new` and not-meaningful changes are dropped; only a
// `changed` + `meaningful:true` entry produces agent input (with the right competitor,
// surface, and low-confidence flag). This is the Bundle-1 merge gate that needs no
// live agent — it proves the filter Bundle 2's receiver will also use.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { actionableInputs } from '../agent/input-contract';
import type { MonitorPagePayload } from '../agent/types';

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '../../docs/samples');

function load(name: string): MonitorPagePayload {
  return JSON.parse(readFileSync(join(SAMPLES, name), 'utf8')) as MonitorPagePayload;
}

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
}

// 1. Baseline `new` (first-ever check): no diff/judgment → not actionable.
const baseline = actionableInputs(load('monitor.page.example.json'));
check('baseline `new` → 0 actionable (skipped)', baseline.length === 0);

// 2. `changed` but judge said not-meaningful (tracking-param churn) → not actionable.
const notMeaningful = actionableInputs(load('monitor.page.changed.example.json'));
check('not-meaningful `changed` → 0 actionable (judge filtered noise)', notMeaningful.length === 0);

// 3. Synthesized `changed` + meaningful:true → exactly 1 actionable, correctly parsed.
const significant = actionableInputs(load('monitor.page.significant.example.json'));
check('meaningful `changed` → 1 actionable', significant.length === 1);
if (significant.length === 1) {
  const input = significant[0]!;
  check('  competitor = servicetitan', input.competitor === 'servicetitan');
  check('  surface resolved to "changelog" from metadata.surfaces', input.surface === 'changelog');
  check('  diff text carried through', input.diffText.includes('AI Permit Assistant'));
  check('  high-confidence judge → not flagged suspect', input.suspectLowConfidence === false);
}

console.log(
  failures === 0
    ? '\nAll input-contract checks passed.'
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
