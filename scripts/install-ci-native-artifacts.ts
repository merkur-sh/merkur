import { appendFileSync } from 'node:fs';
import path from 'node:path';
import {
  EDGE_HARNESS_NATIVE_MANIFEST_ENV,
  provisionEdgeHarnessNativeArtifacts,
} from './edge-harness-native-artifacts';

const manifest = process.env[EDGE_HARNESS_NATIVE_MANIFEST_ENV];
if (manifest === undefined) throw new Error('CI requires an explicit native artifact manifest');
await provisionEdgeHarnessNativeArtifacts(
  path.resolve(import.meta.dir, '..'),
  manifest,
  async () => {
    throw new Error('CI consumers must use the producer artifacts');
  },
);
const environmentFile = process.env.GITHUB_ENV;
if (environmentFile === undefined) throw new Error('GITHUB_ENV is required');
appendFileSync(environmentFile, `${EDGE_HARNESS_NATIVE_MANIFEST_ENV}=${manifest}\n`);
