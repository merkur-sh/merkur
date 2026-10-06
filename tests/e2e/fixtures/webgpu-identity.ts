import type { Page } from '@playwright/test';

export interface WebGpuAdapterIdentity {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean | null;
}

/** Diagnostic name matching only; absence of a match does not prove hardware. */
export function webGpuSoftwareEvidence(
  info: WebGpuAdapterIdentity,
): 'explicit-fallback' | 'name-heuristic' | null {
  if (info.isFallbackAdapter === true) return 'explicit-fallback';
  return /swiftshader|llvmpipe|softpipe|swrast|software/iu.test(
    `${info.vendor} ${info.architecture} ${info.device} ${info.description}`,
  )
    ? 'name-heuristic'
    : null;
}

/**
 * Query the same API/default adapter request as production, never WebGL.
 * This independent page request is capability evidence, NOT an exact identity
 * join with the terminal worker's GPUDevice. Empty/withheld identifiers never
 * disable latency assertions. No adapter/API is an explicit test failure.
 */
export async function readWebGpuIdentity(page: Page) {
  const adapter = await page.evaluate(async (): Promise<WebGpuAdapterIdentity> => {
    if (navigator.gpu === undefined)
      throw new Error('WebGPU unavailable: terminal rendering cannot be measured');
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null)
      throw new Error('WebGPU adapter unavailable: terminal rendering cannot be measured');
    const info = adapter.info;
    // Current API: https://gpuweb.github.io/gpuweb/#dom-gpuadapterinfo-isfallbackadapter
    // Missing metadata is unknown, not a compatibility read from the old API.
    const fallback: unknown = Reflect.get(info, 'isFallbackAdapter');
    return {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter: typeof fallback === 'boolean' ? fallback : null,
    };
  });
  return {
    api: 'webgpu' as const,
    identityScope: 'page-default-webgpu-adapter-probe' as const,
    adapter,
    renderer: JSON.stringify(adapter),
    softwareEvidence: webGpuSoftwareEvidence(adapter),
    browser: page.context().browser()?.browserType().name() ?? '',
    version: page.context().browser()?.version() ?? '',
  };
}
