import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import {
  createProxyControlResponseAssembler,
  type ProxyImpairmentStats,
  parseProxyImpairmentStats,
} from './edge-network-stats';

const CONTROL_TIMEOUT_MS = 1_000;
const CONTROL_RETRY_MS = 100;

/** Request one nonce-fenced, chunk-reassembled full proxy snapshot over loopback UDP. */
export function requestProxyImpairmentStats(
  port: number,
  command: 'reset' | 'stats',
): Promise<ProxyImpairmentStats> {
  const nonce = randomUUID();
  return requestProxyChunkedReply(
    port,
    `${command}:${nonce}`,
    command,
    nonce,
    parseProxyImpairmentStats,
  );
}

/**
 * Send one control request over loopback UDP, resending it until every chunk of
 * its reply has arrived, and resolve the reply `parse` accepts. The proxy caches
 * each reply by request, so a resend replays the same snapshot.
 */
export function requestProxyChunkedReply<T>(
  port: number,
  command: string,
  kind: 'reset' | 'stats' | 'settle' | 'mark',
  nonce: string,
  parse: (value: unknown) => T | null,
): Promise<T> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(new Error('delay proxy control port is invalid'));
  }
  const request = Buffer.from(command);
  const assembler = createProxyControlResponseAssembler(kind, nonce, parse);
  return new Promise<T>((resolve, reject) => {
    const socket = createSocket('udp6');
    let settled = false;
    const finish = (reply?: T, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(retry);
      socket.close();
      if (reply !== undefined) resolve(reply);
      else reject(error ?? new Error(`delay proxy returned no ${kind} reply`));
    };
    const timer = setTimeout(
      () => finish(undefined, new Error(`delay proxy did not acknowledge ${kind} request`)),
      CONTROL_TIMEOUT_MS,
    );
    socket.once('error', (error) => finish(undefined, error));
    socket.on('message', (message) => {
      try {
        const reply = assembler.push(message.toString('utf8'));
        if (reply !== null) finish(reply);
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)));
      }
    });
    const send = (): void => {
      socket.send(request, port, '::1', (error) => {
        if (error !== null) finish(undefined, error);
      });
    };
    const retry = setInterval(send, CONTROL_RETRY_MS);
    send();
  });
}

/**
 * Send one one-datagram control verb, `<verb>:<nonce>[:<argument>]`, resending
 * it until the reply `<acknowledgement>:<nonce>[:...]` arrives, and resolve the
 * reply's fields after the nonce.
 */
export function requestProxyControl(
  port: number,
  verb: string,
  argument: string,
  acknowledgement: string,
): Promise<readonly string[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(new Error('delay proxy control port is invalid'));
  }
  const nonce = randomUUID();
  const request = Buffer.from(`${verb}:${nonce}:${argument}`);
  return new Promise<readonly string[]>((resolve, reject) => {
    const socket = createSocket('udp6');
    let settled = false;
    const finish = (fields?: readonly string[], error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(retry);
      socket.close();
      if (fields !== undefined) resolve(fields);
      else reject(error ?? new Error(`delay proxy refused ${verb}`));
    };
    const timer = setTimeout(
      () => finish(undefined, new Error(`delay proxy did not acknowledge ${verb} request`)),
      CONTROL_TIMEOUT_MS,
    );
    socket.once('error', (error) => finish(undefined, error));
    socket.on('message', (message) => {
      const fields = message.toString('utf8').split(':');
      if (fields[0] === 'error') finish(undefined, new Error(`delay proxy: ${fields.join(':')}`));
      else if (fields[0] === acknowledgement && fields[1] === nonce) finish(fields.slice(2));
    });
    const send = (): void => {
      socket.send(request, port, '::1', (error) => {
        if (error !== null) finish(undefined, error);
      });
    };
    const retry = setInterval(send, CONTROL_RETRY_MS);
    send();
  });
}
