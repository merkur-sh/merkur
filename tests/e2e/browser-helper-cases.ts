import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Schema } from 'effect';
import { expect, test } from './fixtures/daemon-process';
import { expectOutput, primeTerminal } from './terminal-e2e-helpers';

const execute = promisify(execFile);
const modes = ['none', 'sip', 'sip-noquote', 'tftp'] as const;
type Mode = (typeof modes)[number];
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const decodeLog = Schema.decodeUnknownSync(
  Schema.Struct({
    message: Schema.Literal('dataplane_stderr'),
    context: Schema.Struct({ line: Schema.String }),
  }),
);
const decodeRules = Schema.decodeUnknownSync(Schema.Json);

interface HelperEvidence {
  mode: Mode;
  repetition: number;
  passed: boolean;
  initialShellMs?: number;
  outcomes?: string[];
  selectedDirect?: boolean;
  relayWithdrawnAt?: string;
  retainedShellMs?: number;
  issuances?: number;
  daemonRules?: Schema.Json;
  clientRules?: Schema.Json;
}

function outcomeLines(log: string): string[] {
  const lines: string[] = [];
  for (const raw of log.split('\n')) {
    if (!raw.startsWith('{')) continue;
    try {
      const record = decodeLog(JSON.parse(raw));
      for (const line of record.context.line.split('\n')) {
        if (line.includes('webtransport NAT outcome')) lines.push(line.replace(ansi, ''));
      }
    } catch (error) {
      if (error instanceof SyntaxError || Schema.isSchemaError(error)) continue;
      throw error;
    }
  }
  return lines;
}

async function nft(role: string, ...args: string[]): Promise<string> {
  const result = await execute('ip', [
    'netns',
    'exec',
    `merkur-natlab-${role}-cpe`,
    'nft',
    ...args,
  ]);
  return result.stdout;
}

async function configure(mode: Mode): Promise<void> {
  await execute('bash', [
    path.resolve(__dirname, '../../scripts/natlab/native-topology.sh'),
    'clear-peer-flows',
  ]);
  for (const role of ['daemon', 'client']) {
    await nft(role, 'add', 'table', 'inet', 'browser_helper');
  }
  if (mode === 'none') return;
  const helper = mode === 'tftp' ? 'tftp' : 'sip';
  const port = helper === 'tftp' ? '69' : '5060';
  await nft(
    'daemon',
    'add',
    'ct',
    'helper',
    'inet',
    'browser_helper',
    helper,
    `{ type "${helper}" protocol udp; l3proto ip; }`,
  );
  await nft(
    'daemon',
    'add',
    'chain',
    'inet',
    'browser_helper',
    'assign',
    '{ type filter hook prerouting priority 0; policy accept; }',
  );
  await nft(
    'daemon',
    'add',
    'rule',
    'inet',
    'browser_helper',
    'assign',
    'iifname',
    'lan0',
    'udp',
    'dport',
    port,
    'counter',
    'ct',
    'helper',
    'set',
    `"${helper}"`,
  );
  if (mode === 'sip-noquote') {
    await nft(
      'daemon',
      'add',
      'chain',
      'inet',
      'browser_helper',
      'quotes',
      '{ type filter hook prerouting priority -150; policy accept; }',
    );
    await nft(
      'daemon',
      'add',
      'rule',
      'inet',
      'browser_helper',
      'quotes',
      'iifname',
      'wan0',
      'ip',
      'protocol',
      'icmp',
      'counter',
      'drop',
    );
  }
  // A closed, owned SIP/TFTP endpoint returns a real kernel ICMP quotation.
  await nft(
    'client',
    'insert',
    'rule',
    'inet',
    'natlab',
    'input',
    'udp',
    'dport',
    port,
    'reject',
    'with',
    'icmp',
    'type',
    'port-unreachable',
    'comment',
    '"browser-helper-quote"',
  );
}

async function withdrawRelay(): Promise<void> {
  for (const role of ['daemon', 'client']) {
    await nft(
      role,
      'add',
      'chain',
      'inet',
      'browser_helper',
      'withdraw',
      '{ type filter hook forward priority -50; policy accept; }',
    );
    await nft(
      role,
      'add',
      'rule',
      'inet',
      'browser_helper',
      'withdraw',
      'ip',
      'daddr',
      '198.51.100.254',
      'udp',
      'dport',
      '4433',
      'counter',
      'drop',
    );
    await nft(
      role,
      'add',
      'rule',
      'inet',
      'browser_helper',
      'withdraw',
      'ip',
      'saddr',
      '198.51.100.254',
      'udp',
      'sport',
      '4433',
      'counter',
      'drop',
    );
  }
}

async function clean(): Promise<void> {
  for (const role of ['daemon', 'client']) {
    await nft(role, 'delete', 'table', 'inet', 'browser_helper');
  }
  const rules: {
    nftables: { rule?: { handle: number; comment?: string } }[];
  } = JSON.parse(await nft('client', '-j', '-a', 'list', 'chain', 'inet', 'natlab', 'input'));
  for (const entry of rules.nftables) {
    if (entry.rule?.comment !== 'browser-helper-quote') continue;
    await nft(
      'client',
      'delete',
      'rule',
      'inet',
      'natlab',
      'input',
      'handle',
      String(entry.rule.handle),
    );
  }
  await execute('bash', [
    path.resolve(__dirname, '../../scripts/natlab/native-topology.sh'),
    'clear-peer-flows',
  ]);
  const output = process.env.PW_E2E_OUTPUT_DIR;
  if (output === undefined) throw new Error('The owned relay proxy logs are required');
  for (const role of ['daemon', 'client']) {
    const log = path.join(path.dirname(output), `${role}-relay.log`);
    const resets = (): number => readFileSync(log, 'utf8').split('NATLAB_PROXY_RESET\n').length - 1;
    const previous = resets();
    const pid = Number(
      readFileSync(`/tmp/merkur-native-topology/proxy-${role}-relay.pid`, 'utf8').trim(),
    );
    process.kill(pid, 'SIGUSR1');
    await expect
      .poll(resets, { message: 'The completed test must retire its proxy sockets' })
      .toBe(previous + 1);
  }
}

for (let repetition = 1; repetition <= 3; repetition += 1) {
  for (const mode of modes) {
    test(`browser helper ${mode} retains its authorized shell, repetition ${repetition}`, async ({
      page,
      linkedDaemon,
    }) => {
      const evidence = process.env.PW_E2E_OUTPUT_DIR;
      if (evidence === undefined) throw new Error('The owned routed NAT lab is required');
      expect(process.env.MERKUR_NATLAB_CASE).toBe('eim-pdf');
      const record: HelperEvidence = { mode, repetition, passed: false };
      await configure(mode);
      try {
        await page.context().grantPermissions(['local-network-access'], { origin: page.url() });
        let issuances = 0;
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/sessions/request') issuances += 1;
        });
        const mark = linkedDaemon.logText().length;
        const started = performance.now();
        const output = await primeTerminal(page, linkedDaemon.daemonName);
        record.initialShellMs = performance.now() - started;
        const sentinel = `${mode.replaceAll('-', '_')}_${repetition}_${process.pid}`;
        await page.keyboard.type(
          `helper_sentinel=${sentinel}; printf '%s%s\\n' helper_ready_ "$helper_sentinel"\n`,
        );
        await expectOutput(output, `helper_ready_${sentinel}`);
        await expect
          .poll(() => outcomeLines(linkedDaemon.logText().slice(mark)).length, {
            timeout: 30_000,
            message: 'The actual browser NAT race must report its terminal outcome',
          })
          .toBeGreaterThan(0);
        const outcomes = outcomeLines(linkedDaemon.logText().slice(mark));
        record.outcomes = outcomes;
        const selected = outcomes.some((line) => line.includes('outcome="selected"'));
        record.selectedDirect = selected;
        const initialIssuances = issuances;
        if (selected) {
          await withdrawRelay();
          record.relayWithdrawnAt = new Date().toISOString();
        }
        // Fresh shell-generated records span the background control-work lifetime.
        // The shell variable must survive; neither a typed echo nor a new PTY passes.
        await page.keyboard.type(
          'for helper_tick in $(seq 1 16); do printf \'%s%s_%s\\n\' helper_alive_ "$helper_sentinel" "$helper_tick"; sleep 1; done\n',
        );
        await expectOutput(output, `helper_alive_${sentinel}_16`, 25_000);
        expect(issuances, 'The original issued session must carry every command').toBe(
          initialIssuances,
        );
        if (selected) {
          await expect(page.getByTitle(/^Direct(?: · \d+ms)?\. Traffic/u).first()).toBeVisible();
        } else {
          await expect(page.getByTitle(/^Relay(?: · \d+ms)?\. Traffic/u).first()).toBeVisible();
        }
        record.retainedShellMs = performance.now() - started;
        record.issuances = issuances;
        record.passed = true;
        await page.screenshot({ path: test.info().outputPath('authenticated-shell.png') });
      } finally {
        record.daemonRules = decodeRules(JSON.parse(await nft('daemon', '-j', 'list', 'ruleset')));
        record.clientRules = decodeRules(JSON.parse(await nft('client', '-j', 'list', 'ruleset')));
        const json = `${JSON.stringify(record, null, 2)}\n`;
        writeFileSync(
          path.join(path.dirname(evidence), `browser-helper-${mode}-${repetition}.json`),
          json,
        );
        await test
          .info()
          .attach('browser-helper-outcome.json', { body: json, contentType: 'application/json' });
        await clean();
      }
    });
  }
}
