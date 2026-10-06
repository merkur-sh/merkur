import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectSources } from './project-sources';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wasm-projection-'));
  const packageTree = path.join(root, 'package');
  await mkdir(packageTree);
  const names = ['demo.js', 'demo.d.ts', 'demo_bg.wasm', 'demo_bg.wasm.d.ts', 'package.json'];
  const members = [];
  for (const member of names) {
    const content = Buffer.from(member);
    await writeFile(path.join(packageTree, member), content);
    members.push({
      member,
      size: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  const inventory = { producer: '@@//package:producer', module: 'demo', members };
  const specification = {
    producer: '@@//web:runtime',
    projection: '@@//web:projection',
    packageProducer: inventory.producer,
    files: names.slice(0, 4).map((member) => ({
      member,
      output: `outputs/${member}`,
      artifact: `web/projection/${member}`,
      destination: `web/src/pkg/${member}`,
    })),
  };
  const inventoryFile = path.join(root, 'inventory.json');
  const specificationFile = path.join(root, 'specification.json');
  await writeFile(inventoryFile, JSON.stringify(inventory));
  await writeFile(specificationFile, JSON.stringify(specification));
  return {
    root,
    packageTree,
    inventory,
    inventoryFile,
    specification,
    specificationFile,
    run: () => projectSources(packageTree, specificationFile, 'sources.json', inventoryFile, root),
  };
}

test('projection binds complete producer facts and accepts engine member presentations', async () => {
  const item = await fixture();
  try {
    const original = path.join(item.root, 'declared-file');
    await writeFile(original, 'demo.js');
    await rm(path.join(item.packageTree, 'demo.js'));
    await symlink(original, path.join(item.packageTree, 'demo.js'));
    await item.run();
    const manifest = JSON.parse(await readFile(path.join(item.root, 'sources.json'), 'utf8'));
    expect(Object.keys(manifest).sort()).toEqual(['producer', 'projection', 'sources']);
    expect(manifest.sources).toHaveLength(4);
    expect(await readFile(path.join(item.root, 'outputs/demo.js'), 'utf8')).toBe('demo.js');
  } finally {
    await rm(item.root, { recursive: true });
  }
});

test('projection rejects foreign bytes through package and member aliases', async () => {
  for (const packageAlias of [false, true]) {
    const item = await fixture();
    try {
      const foreign = path.join(item.root, 'foreign');
      await mkdir(foreign);
      for (const fact of item.inventory.members)
        await writeFile(path.join(foreign, fact.member), 'outside');
      if (packageAlias) {
        await rm(item.packageTree, { recursive: true });
        await symlink(foreign, item.packageTree);
      } else {
        await rm(path.join(item.packageTree, 'demo.js'));
        await symlink(path.join(foreign, 'demo.js'), path.join(item.packageTree, 'demo.js'));
      }
      await expect(item.run()).rejects.toThrow('original producer inventory');
    } finally {
      await rm(item.root, { recursive: true });
    }
  }
});

test('projection rejects existing output aliases without modifying their referents', async () => {
  for (const output of ['outputs/demo.js', 'sources.json', 'outputs']) {
    const item = await fixture();
    try {
      const foreign = path.join(item.root, 'foreign');
      if (output === 'outputs') await mkdir(foreign);
      else await writeFile(foreign, 'retained');
      if (output.includes('/')) await mkdir(path.join(item.root, 'outputs'));
      await symlink(foreign, path.join(item.root, output));
      await expect(item.run()).rejects.toThrow();
      if (output !== 'outputs') expect(await readFile(foreign, 'utf8')).toBe('retained');
    } finally {
      await rm(item.root, { recursive: true });
    }
  }
});

test('projection rejects foreign inventory, missing package members and duplicate destinations', async () => {
  for (const change of ['producer', 'membership', 'destination', 'unknown']) {
    const item = await fixture();
    try {
      if (change === 'producer') item.inventory.producer = '@@//foreign:producer';
      if (change === 'membership') item.inventory.members.pop();
      if (change === 'destination') {
        const first = item.specification.files[0];
        const second = item.specification.files[1];
        if (first === undefined || second === undefined) throw new Error('Fixture requires files');
        second.destination = first.destination;
      }
      await writeFile(item.inventoryFile, JSON.stringify(item.inventory));
      await writeFile(
        item.specificationFile,
        JSON.stringify(
          change === 'unknown' ? { ...item.specification, extra: true } : item.specification,
        ),
      );
      await expect(item.run()).rejects.toThrow();
    } finally {
      await rm(item.root, { recursive: true });
    }
  }
});
