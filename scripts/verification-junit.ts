import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only complete, internally consistent runner reports can attribute a green file. */
export function greenTestFiles(xml: string, root: string, selected: readonly string[]): string[] {
  if (XMLValidator.validate(xml) !== true) return [];
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    isArray: (name) => name === 'testsuite' || name === 'testcase',
  }).parse(xml);
  if (!record(parsed) || !record(parsed.testsuites)) return [];
  const report = parsed.testsuites;
  const files = new Map<string, { tests: number; failed: boolean }>();
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  let valid = true;
  function visit(node: Record<string, unknown>, inheritedFile?: string): void {
    const file = typeof node['@_file'] === 'string' ? node['@_file'] : inheritedFile;
    if (node.testcase !== undefined) {
      if (!Array.isArray(node.testcase)) {
        valid = false;
        return;
      }
      for (const item of node.testcase) {
        if (!record(item)) {
          valid = false;
          continue;
        }
        const owner = typeof item['@_file'] === 'string' ? item['@_file'] : file;
        if (owner === undefined) {
          valid = false;
          continue;
        }
        const name = path.resolve(root, owner);
        const state = files.get(name) ?? { tests: 0, failed: false };
        const failed = 'failure' in item || 'error' in item;
        state.tests++;
        state.failed ||= failed;
        files.set(name, state);
        tests++;
        if (failed) failures++;
        if ('skipped' in item) skipped++;
      }
    }
    if (node.testsuite !== undefined) {
      if (!Array.isArray(node.testsuite)) {
        valid = false;
        return;
      }
      for (const suite of node.testsuite) {
        if (!record(suite)) {
          valid = false;
          continue;
        }
        visit(suite, file);
      }
    }
  }
  visit(report);
  if (
    !valid ||
    report['@_tests'] !== String(tests) ||
    report['@_failures'] !== String(failures) ||
    report['@_skipped'] !== String(skipped) ||
    (report['@_errors'] !== undefined && report['@_errors'] !== '0')
  )
    return [];
  return selected.filter((file) => {
    const state = files.get(path.resolve(root, file));
    return state !== undefined && state.tests > 0 && !state.failed;
  });
}
