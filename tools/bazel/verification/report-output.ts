import { realpathSync } from 'node:fs';
import path from 'node:path';
import { openOwnedDirectory } from '../bun/owned-files';

export interface ReportOutput {
  readonly write: (content: string) => void;
  readonly close: () => void;
}

interface OutputState {
  readonly requestedParent: string;
  readonly parent: string;
  readonly directory: ReturnType<typeof openOwnedDirectory>;
  readonly member: string;
  written: boolean;
  closed: boolean;
}

const outputs = new WeakMap<ReportOutput, OutputState>();

function outputState(output: ReportOutput): OutputState {
  const state = outputs.get(output);
  if (state === undefined || state.closed)
    throw new Error('An open owned report output is required');
  if (realpathSync(state.requestedParent) !== state.parent)
    throw new Error('Report publication parent changed');
  return state;
}

/** Recheck the actual held publication destination against a trusted source root. */
export function assertReportOutputOutside(output: ReportOutput, workspace: string): void {
  const { parent } = outputState(output);
  if (!path.isAbsolute(workspace)) throw new Error('Absolute source path required');
  const relative = path.relative(realpathSync(workspace), parent);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)))
    throw new Error('Verification reports must remain outside source inputs');
}

/** Verify the bytes and namespace retained by the actual publisher, not a submitted receipt. */
export function verifyReportOutput(output: ReportOutput): void {
  const state = outputState(output);
  if (!state.written) throw new Error('Report output has not been durably published');
  state.directory.verify(state.member);
  outputState(output);
}

/** Preserve an existing expectation publication when an earlier phase fails. */
export function reportOutputPublished(output: ReportOutput): boolean {
  const published = outputState(output).written;
  if (published) verifyReportOutput(output);
  return published;
}

/** Retire only this publisher's created inode before replacing a failed attempt's diagnostics. */
export function retireReportOutput(output: ReportOutput): void {
  const state = outputState(output);
  state.directory.removeCreated();
  state.written = false;
}

/** Retain every publication ancestor before awaiting work; a changed caller parent cannot redirect it. */
export function openReportOutput(file: string, workspace: string): ReportOutput {
  if (!path.isAbsolute(file) || !path.isAbsolute(workspace))
    throw new Error('Absolute report and source paths required');
  const requestedParent = path.dirname(file);
  const parent = realpathSync(requestedParent);
  const source = realpathSync(workspace);
  const relative = path.relative(source, parent);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)))
    throw new Error('Verification reports must remain outside source inputs');
  const root = path.parse(parent).root;
  const directory = openOwnedDirectory(root);
  const retainedParent = path.relative(root, parent);
  try {
    if (retainedParent !== '') directory.directory(retainedParent);
  } catch (error) {
    directory.close();
    throw error;
  }
  const member = path.relative(root, path.join(parent, path.basename(file)));
  const state: OutputState = {
    requestedParent,
    parent,
    directory,
    member,
    written: false,
    closed: false,
  };
  const output: ReportOutput = Object.freeze({
    write(content: string) {
      outputState(output);
      if (state.written) throw new Error('Report output can be published only once');
      directory.write(member, content, 0o600);
      directory.sync(member);
      outputState(output);
      directory.verify(member);
      state.written = true;
    },
    close() {
      state.closed = true;
      directory.close();
    },
  });
  outputs.set(output, state);
  return output;
}
