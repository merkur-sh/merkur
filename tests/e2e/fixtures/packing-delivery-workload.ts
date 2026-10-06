/** Deterministic application fixture; no Merkur product hook or prediction grant. */
export interface PackingDeliveryShape {
  readonly cols: number;
  readonly rows: number;
  readonly entropy: boolean;
}

export function packingDeliveryApplication(
  shape: PackingDeliveryShape,
  statusPath: string,
): string {
  if (
    ![
      [120, 40],
      [384, 256],
    ].some(([cols, rows]) => cols === shape.cols && rows === shape.rows) ||
    !statusPath.startsWith('/') ||
    statusPath.includes('\0')
  )
    throw new Error('invalid packing application fixture');
  // At most two bounded full-screen payloads are retained. They are prepared
  // before READY, never after a measured input; every redraw alternates all
  // glyphs. The app's timing record is buffered and written only at teardown.
  return `const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const config = ${JSON.stringify({ ...shape, statusPath })};
const ESC = '\\x1b';
const plainStyle = ESC+'[0m'+ESC+'[38;2;222;223;224m'+ESC+'[48;2;13;14;15m';
let prepared = false, redraw = 0, followup = 0, header = 0;
let payloads = [], rowsText = [], records = [];
function now() { return performance.now(); }
function marker() { return 'PACK-r' + String(redraw).padStart(6,'0') + '-x' + String(followup).padStart(6,'0') + '-h' + String(header).padStart(6,'0'); }
function prepare() {
  const size = execFileSync('/bin/stty',['size'],{stdio:[0,'pipe',2]}).toString().trim().split(/\\s+/).map(Number);
  const actual = { rows:size[0], cols:size[1] };
  prepared = actual.rows === config.rows && actual.cols === config.cols;
  fs.writeFileSync(config.statusPath, JSON.stringify({actual, target:config, prepared}));
  if (!prepared) { process.stdout.write(ESC+'[2J'+ESC+'[H'+'PACK-SIZE '+actual.cols+'x'+actual.rows); return; }
  payloads = []; rowsText = [];
  for (let variant=0; variant<2; variant++) {
    let state = (0x714329ab ^ variant) >>> 0, parts = [ESC+'[?2026h',plainStyle], lines=[];
    for (let row=0; row<config.rows; row++) {
      parts.push(ESC+'['+(row+1)+';1H');
      let line='';
      for (let col=0; col<config.cols; col++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        const ch = config.entropy ? String.fromCharCode(33+((state>>>0)%94)) : ((row+col+variant)%2 ? 'b':'a');
        if (col%8===0) parts.push(ESC+'[38;5;'+((row+col+variant)%216+16)+'m');
        parts.push(ch); line += ch;
      }
      lines.push(line);
    }
    payloads.push(Buffer.from(parts.join(''))); rowsText.push(lines);
  }
  process.stdout.write(plainStyle+ESC+'[2 q'+ESC+'[?25h'+ESC+'[2J'+ESC+'[H'+'PACK-READY '+config.cols+'x'+config.rows);
}
function finish() {
  fs.writeFileSync(config.statusPath+'.events.json',JSON.stringify({records,redraw,followup,header,payloadBytes:payloads.map(p=>p.length),rowsText}));
}
process.stdout.on('resize',prepare);
process.on('SIGTERM',()=>{finish();process.exit(0)});
process.on('SIGINT',()=>{finish();process.exit(0)});
process.stdin.on('data',bytes=>{
  for (const byte of bytes) {
    if (byte===113) { finish(); process.exit(0); }
    if (!prepared || records.length>=2000 || ![114,120,104].includes(byte)) { finish(); process.exit(2); }
    const received=now();
    if (byte===114) {
      redraw++; process.stdout.write(payloads[redraw%2]);
      process.stdout.write(plainStyle+ESC+'[1;1H'+marker()+ESC+'['+config.rows+';1H'+ESC+'[?2026l');
    } else if (byte===120) {
      followup++; process.stdout.write(plainStyle+ESC+'[1;1H'+marker()+ESC+'['+config.rows+';1H'+'X');
    } else {
      header++; process.stdout.write(ESC+'['+(header%2?'6':'2')+' q');
    }
    records.push({byte,received,writeReturned:now(),redraw,followup,header});
  }
});
prepare();
`;
}

export function packingMarker(redraw: number, followup: number, header: number): string {
  if (
    ![redraw, followup, header].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value < 1_000_000,
    )
  )
    throw new Error('invalid packing operation ordinal');
  return `PACK-r${String(redraw).padStart(6, '0')}-x${String(followup).padStart(6, '0')}-h${String(header).padStart(6, '0')}`;
}

/** Independent plain-cell oracle; no ANSI decoder or received row count. */
export function packingExpectedViewport(
  shape: PackingDeliveryShape,
  redraw: number,
  followup: number,
  header: number,
): string {
  const marker = packingMarker(redraw, followup, header);
  const variant = redraw % 2;
  let state = (0x714329ab ^ variant) >>> 0;
  const lines: string[] = [];
  for (let row = 0; row < shape.rows; row++) {
    let line = '';
    for (let col = 0; col < shape.cols; col++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      line += shape.entropy
        ? String.fromCharCode(33 + ((state >>> 0) % 94))
        : (row + col + variant) % 2
          ? 'b'
          : 'a';
    }
    if (row === 0) line = marker + line.slice(marker.length);
    if (row === shape.rows - 1 && followup > 0) line = `X${line.slice(1)}`;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Absolute canonical row oracle, independent of any observed browser/daemon
 * state. The supplied hash is the standard XXH3-64 primitive; packing the
 * expected codepoint/fg/bg/flags bytes here does not decode sender payloads.
 * Invoked before startup by the Bun preparer, not inside the measured window.
 */
export function packingExpectedCanonicalRows(
  shape: PackingDeliveryShape,
  redraw: number,
  followup: number,
  header: number,
  xxh3: (bytes: Uint8Array) => bigint,
): string[] {
  const lines = packingExpectedViewport(shape, redraw, followup, header).split('\n');
  const markerLength = packingMarker(redraw, followup, header).length;
  const levels = [0, 95, 135, 175, 215, 255];
  const hashes: string[] = [];
  const digest = new Uint8Array(shape.cols * 11);
  const view = new DataView(digest.buffer);
  for (let row = 0; row < shape.rows; row++) {
    const line = lines[row];
    if (line === undefined || line.length !== shape.cols)
      throw new Error('invalid absolute packing row');
    for (let col = 0; col < shape.cols; col++) {
      const offset = col * 11;
      view.setUint32(offset, line.charCodeAt(col), true);
      const plain =
        (row === 0 && col < markerLength) || (row === shape.rows - 1 && col === 0 && followup > 0);
      const palette = (row + Math.floor(col / 8) * 8 + (redraw % 2)) % 216;
      const fg = plain
        ? [222, 223, 224]
        : [
            levels[Math.floor(palette / 36)],
            levels[Math.floor(palette / 6) % 6],
            levels[palette % 6],
          ];
      if (fg.some((component) => component === undefined)) throw new Error('invalid fixed palette');
      for (let channel = 0; channel < 3; channel++) {
        const component = fg[channel];
        if (component === undefined) throw new Error('missing fixed color');
        digest[offset + 4 + channel] = component;
        digest[offset + 7 + channel] = 13 + channel;
      }
      // ASCII, regular style, no inverse, no wide cell, no soft wrap. Every
      // full row is followed by CUP, which cancels pending wrap before print.
      digest[offset + 10] = 0;
    }
    const hash = xxh3(digest);
    if (hash < 0n || hash > 0xffff_ffff_ffff_ffffn) throw new Error('invalid XXH3-64 result');
    hashes.push(hash.toString(16).padStart(16, '0'));
  }
  return hashes;
}
