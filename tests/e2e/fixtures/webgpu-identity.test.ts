import { expect, test } from 'bun:test';
import { type WebGpuAdapterIdentity, webGpuSoftwareEvidence } from './webgpu-identity';

const blank: WebGpuAdapterIdentity = {
  vendor: '',
  architecture: '',
  device: '',
  description: '',
  isFallbackAdapter: null,
};

test('explicit WebGPU fallback evidence takes precedence over masked names', () => {
  expect(webGpuSoftwareEvidence({ ...blank, isFallbackAdapter: true })).toBe('explicit-fallback');
});

test('software-name evidence stays a heuristic, and withheld metadata never waives budgets', () => {
  expect(
    webGpuSoftwareEvidence({
      ...blank,
      description: 'SwiftShader Device',
      isFallbackAdapter: false,
    }),
  ).toBe('name-heuristic');
  expect(webGpuSoftwareEvidence(blank)).toBeNull();
  expect(
    webGpuSoftwareEvidence({ ...blank, vendor: 'apple', isFallbackAdapter: false }),
  ).toBeNull();
});
