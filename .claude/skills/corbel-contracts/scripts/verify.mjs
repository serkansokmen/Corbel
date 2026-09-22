// Runs every offline Corbel check and prints one summary. Exit code 1 if any check fails.
// No GPU, model weights or running services needed. Run from the repository root:
//   node .claude/skills/corbel-contracts/scripts/verify.mjs [--skip-typecheck]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../..');
const here = path.relative(root, import.meta.dirname);
const python = [path.join(root, '.backend-venv', 'Scripts', 'python.exe'), path.join(root, '.backend-venv', 'bin', 'python')].find(existsSync) ?? 'python';

const steps = [
  !process.argv.includes('--skip-typecheck') && { name: 'svelte-check (npm run check)', cmd: 'npm', args: ['run', 'check'], shell: true },
  { name: 'retrieval invariants (node --test)', cmd: process.execPath, args: ['--test', path.join(here, 'retrieval.test.mjs')] },
  { name: 'backend contract smoke (fake model)', cmd: python, args: [path.join(here, 'contract_smoke.py')] }
].filter(Boolean);

const results = [];
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const run = spawnSync(step.cmd, step.args, { cwd: root, stdio: 'inherit', shell: step.shell ?? false });
  results.push({ name: step.name, ok: run.status === 0, note: run.error?.message });
}

console.log('\n=== summary ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? `  (${r.note})` : ''}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
