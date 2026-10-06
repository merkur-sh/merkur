import { describe, expect, test } from 'bun:test';

import {
  dockerHealthStatusFromEventLine,
  dockerHealthWatchCommand,
  dragonflyCreateCommand,
  parseDragonflyPort,
} from './dragonfly-container';

describe('Dragonfly container ownership', () => {
  test('creates a current pinned image with an internal health check', () => {
    const command = dragonflyCreateCommand();
    expect(command.slice(0, 2)).toEqual(['docker', 'create']);
    expect(command).toContain('--health-cmd');
    expect(command.at(-1)).toMatch(/dragonfly:v\d+\.\d+\.\d+$/);
  });

  test('parses loopback Docker port mappings only', () => {
    expect(parseDragonflyPort('127.0.0.1:49153\n')).toBe('49153');
    expect(parseDragonflyPort('[::1]:49154\n')).toBe('49154');
    expect(() => parseDragonflyPort('0.0.0.0:49153\n')).toThrow(
      'Could not resolve Dragonfly host port',
    );
  });

  test('recognizes terminal health transitions and ignores unrelated events', () => {
    expect(dockerHealthStatusFromEventLine('health_status: healthy')).toBe('healthy');
    expect(dockerHealthStatusFromEventLine(' health_status: unhealthy ')).toBe('unhealthy');
    expect(dockerHealthStatusFromEventLine('start')).toBeNull();
  });

  test('watches the current Docker event action field without deprecated aliases', () => {
    expect(dockerHealthWatchCommand('container-id')).toEqual([
      'docker',
      'events',
      '--filter=container=container-id',
      '--format={{.Action}}',
    ]);
  });
});
