type Fields = Readonly<Record<string, unknown>>;

function object(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(value: unknown, fields: readonly string[]): Fields | undefined {
  if (!object(value)) return undefined;
  return Object.fromEntries(
    fields.filter((field) => field in value).map((field) => [field, value[field]]),
  );
}

/** BEP command lines contain inherited shell variables. Persist only verification evidence. */
export function sanitizeBuildEvents(text: string): string {
  return (
    text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const event: unknown = JSON.parse(line);
        if (!object(event) || !object(event.id)) throw new Error('Invalid build event');
        const safe: Record<string, unknown> = { id: event.id };
        if (event.children !== undefined) safe.children = event.children;
        if (event.lastMessage !== undefined) safe.lastMessage = event.lastMessage;
        const started = pick(event.started, ['uuid', 'buildToolVersion', 'command']);
        if (started !== undefined) safe.started = started;
        if (object(event.finished))
          safe.finished = { exitCode: pick(event.finished.exitCode, ['code', 'name']) };
        if (object(event.completed)) {
          safe.completed = {
            ...pick(event.completed, ['success']),
            ...(Array.isArray(event.completed.outputGroup)
              ? {
                  outputGroup: event.completed.outputGroup.map((group: unknown) => {
                    const selected = pick(group, ['name', 'incomplete']);
                    if (!object(group) || !Array.isArray(group.fileSets)) return selected;
                    return {
                      ...selected,
                      fileSets: group.fileSets.map((set: unknown) => pick(set, ['id'])),
                    };
                  }),
                }
              : {}),
          };
        }
        if (object(event.namedSetOfFiles)) {
          safe.namedSetOfFiles = {
            ...(Array.isArray(event.namedSetOfFiles.files)
              ? {
                  files: event.namedSetOfFiles.files.map((file: unknown) => ({
                    ...pick(file, ['name', 'pathPrefix', 'digest', 'length', 'symlink']),
                    ...(object(file) &&
                    (file.symlinkTargetPath !== undefined || file.symlink === true)
                      ? { symlink: true }
                      : {}),
                  })),
                }
              : {}),
            ...(Array.isArray(event.namedSetOfFiles.fileSets)
              ? {
                  fileSets: event.namedSetOfFiles.fileSets.map((set: unknown) => pick(set, ['id'])),
                }
              : {}),
          };
        }
        if (object(event.testResult)) {
          safe.testResult = {
            ...pick(event.testResult, ['status', 'cachedLocally', 'testAttemptDuration']),
            executionInfo: pick(event.testResult.executionInfo, [
              'cachedRemotely',
              'exitCode',
              'strategy',
            ]),
          };
        }
        if (object(event.testSummary)) {
          safe.testSummary = pick(event.testSummary, [
            'overallStatus',
            'totalRunCount',
            'totalNumCached',
            'runCount',
            'attemptCount',
            'shardCount',
          ]);
        }
        if (object(event.aborted)) safe.aborted = pick(event.aborted, ['reason']);
        return JSON.stringify(safe);
      })
      .join('\n') + '\n'
  );
}

/** Keep client metadata free of unrelated shell credentials before contacting a BES backend. */
export function bazelClientEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'PATH']) {
    const value = environment[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
