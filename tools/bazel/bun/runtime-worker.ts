self.onmessage = (event: MessageEvent<number>) => {
  self.postMessage({ version: Bun.version, doubled: event.data * 2 });
};
