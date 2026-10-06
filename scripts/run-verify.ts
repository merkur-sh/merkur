import path from 'node:path';
import { verificationPlan } from './select-gates';
import { discoverTests } from './test-inventory';
import { executePlan } from './verification-executor';

process.exitCode = await executePlan(
  verificationPlan('verify', discoverTests(path.resolve(import.meta.dir, '..'))),
);
