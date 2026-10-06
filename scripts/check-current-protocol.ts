import { verificationPlan } from './select-gates';
import { executePlan } from './verification-executor';

process.exitCode = await executePlan(verificationPlan('protocol', []));
