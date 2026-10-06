import type { Page } from '@playwright/test';

export async function pixelCounts(page: Page, redValue = 255) {
  // Read actual compositor output. A WebGPU canvas's transient drawing
  // buffer is not a retained screenshot after the browser presents it.
  const screenshot = await page.screenshot();
  return page.evaluate(
    async ({ png, redValue }) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }),
      );
      const diagnostic = document.createElement('canvas');
      diagnostic.width = bitmap.width;
      diagnostic.height = bitmap.height;
      const context = diagnostic.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('missing diagnostic context');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const rgba = context.getImageData(0, 0, diagnostic.width, diagnostic.height).data;
      let red = 0;
      let green = 0;
      let blue = 0;
      let blend = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i] === redValue && rgba[i + 1] === 0 && rgba[i + 2] === 0) red++;
        if (rgba[i] === 0 && rgba[i + 1] === 255 && rgba[i + 2] === 0) green++;
        if (rgba[i] === 0 && rgba[i + 1] === 0 && rgba[i + 2] === 255) blue++;
        if (rgba[i] === 0 && rgba[i + 1] === 127 && rgba[i + 2] === 128) blend++;
      }
      return { red, green, blue, blend };
    },
    { png: screenshot.toString('base64'), redValue },
  );
}
