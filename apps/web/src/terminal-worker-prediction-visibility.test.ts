import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MESSAGE_TYPE_EDITOR_ANCHOR } from '@merkur/protocol';
import {
  DISPLAY_BASE_SEQ_OFFSET,
  DISPLAY_ECHO_HORIZON_OFFSET,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  TRANSPORT_CHANNEL_ID,
  writeU32BE,
} from '@merkur/shared';
import { createViewerDriver } from '../../../scripts/perf/client-viewer-driver';
import { ingressFixture } from '../../../scripts/term-wasm-ingress-fixture';
import {
  createPredictionFastPathBuffer,
  createPredictionFastPathConsumer,
  createPredictionFastPathWriter,
  createPredictionFastStateReader,
} from './terminal/prediction-fast-path';
import { createProvisionalPreviewState } from './terminal/provisional-preview';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
function production(...names: string[]) {
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(
    names
      .map((name) => {
        const start = source.indexOf(`function ${name}(`),
          end = source.indexOf('\n}', start);
        if (start < 0 || end < start) throw new Error(`missing worker ${name}`);
        return source.slice(start, end + 2);
      })
      .join('\n'),
  );
}
function screen(seq: number, text: string, modes: number, through: number) {
  const bytes = ingressFixture(20, 2, 1, 0, false);
  const data = new DataView(bytes.buffer);
  bytes[DISPLAY_PATCH_FLAGS_OFFSET] = seq === 0 ? 1 : 0;
  writeU32BE(bytes, DISPLAY_SEQUENCE_OFFSET, seq);
  writeU32BE(bytes, DISPLAY_FRAME_ID_OFFSET, seq + 1);
  writeU32BE(bytes, DISPLAY_BASE_SEQ_OFFSET, through);
  writeU32BE(bytes, DISPLAY_ECHO_HORIZON_OFFSET, through);
  data.setUint16(DISPLAY_STREAM_HEADER_BYTES + 6, text.length);
  bytes[DISPLAY_STREAM_HEADER_BYTES + 10] = 0x11;
  data.setUint16(DISPLAY_STREAM_HEADER_BYTES + 11, modes);
  for (let col = 0; col < 20; col++)
    bytes[DISPLAY_ROWS_OFFSET + 10 + col * 2] = text.charCodeAt(col) || 32;
  return bytes;
}
function anchor() {
  const bytes = new Uint8Array(14),
    data = new DataView(bytes.buffer);
  bytes[0] = MESSAGE_TYPE_EDITOR_ANCHOR;
  data.setUint16(2, 10);
  data.setUint32(4, 1);
  data.setUint16(10, 2);
  data.setUint16(12, 1);
  return bytes;
}
function prompt(granted = true) {
  const driver = createViewerDriver(20, 2),
    viewer = driver.viewer;
  viewer.reset_session();
  viewer.set_presentation_ready(true);
  viewer.fence(0, 1);
  viewer.set_input_mapping(1, 0, 1, 64);
  driver.receive(screen(0, '$ ', granted ? 32 : 0, 0), 4, 0);
  driver.receive(anchor(), TRANSPORT_CHANNEL_ID.ctrl, 0);
  viewer.present_now(0);
  let local = 0,
    sequence = 0,
    text = '$ ';
  return {
    ...driver,
    key(character: string, visible = false) {
      text += character;
      return viewer.prediction_command(++local, local, 1, character.charCodeAt(0), visible);
    },
    echo(value = text, modes = 32, through = local) {
      driver.receive(screen(++sequence, value, modes, through), 3, local + sequence);
      viewer.present_now(local + sequence);
    },
    flush() {
      return viewer.prediction_command(++local, local, 5, 0, false);
    },
    line() {
      return viewer.presentation_viewport_rows().split('\n')[0]?.trimEnd();
    },
    visible() {
      viewer.build_geometry();
      return Array.from(
        new Uint32Array(
          driver.memory.buffer,
          viewer.visible_prediction_input_seqs_ptr(),
          viewer.visible_prediction_input_seqs_len(),
        ),
      );
    },
  };
}

test('captured visible input remains visible while current worker trust is learning', () => {
  const owner = prompt();
  try {
    expect(owner.key('a')).toBe(true);
    owner.echo();
    expect(owner.viewer.prediction_state()).toBe(0);
    expect(owner.key('x', true)).toBe(true);
    expect(owner.visible()).toEqual([2]);
  } finally {
    owner.close();
  }
});

test('captured hidden input is never promoted when later worker trust becomes visible', () => {
  const owner = prompt();
  try {
    for (const character of 'abc') {
      expect(owner.key(character)).toBe(true);
      owner.echo();
    }
    expect(owner.viewer.prediction_state()).toBe(1);
    expect(owner.key('x', false)).toBe(true);
    expect(owner.viewer.has_predictions()).toBe(true);
    expect(owner.line()).toBe('$ abc');
    expect(owner.visible()).toEqual([]);
  } finally {
    owner.close();
  }
});

test('a newer authenticated fence discards committed predictions and resets trust', () => {
  const owner = prompt();
  try {
    owner.key('a');
    owner.echo();
    expect(owner.key('x', true)).toBe(true);
    expect(owner.visible()).toEqual([2]);
    owner.viewer.fence(20, 2);
    expect(owner.viewer.has_predictions()).toBe(false);
    expect(owner.line()).toBe('$ a');
    expect(owner.viewer.prediction_state()).toBe(0);
  } finally {
    owner.close();
  }
});

test('withdrawn prompt authority refuses captured commands until their causal barrier is covered', () => {
  const owner = prompt(false);
  try {
    expect(owner.key('x', true)).toBe(false);
    owner.echo('$ ', 32, 0);
    expect(owner.key('y', true)).toBe(false);
    expect(owner.viewer.has_predictions()).toBe(false);
    owner.echo('$ xy', 32);
    expect(owner.key('z', false)).toBe(true);
  } finally {
    owner.close();
  }
});

test('an unmodelled flush seals painted glyphs until their echo, and refuses following keys', () => {
  const owner = prompt();
  try {
    owner.key('a');
    owner.echo();
    expect(owner.key('x', true)).toBe(true);
    owner.flush();
    expect(owner.visible()).toEqual([2]);
    expect(owner.key('y', true)).toBe(false);
    owner.echo('$ ax');
    expect(owner.viewer.has_predictions()).toBe(false);
  } finally {
    owner.close();
  }
});

test('model retirement after contradictory authority removes the speculative glyphs at its real deadline', () => {
  const owner = prompt();
  try {
    owner.key('a');
    owner.echo();
    owner.key('x', true);
    owner.echo('$ ab');
    const deadline = owner.viewer.next_deadline();
    expect(Number.isFinite(deadline)).toBe(true);
    owner.viewer.handle_timeout(deadline);
    expect(owner.viewer.has_predictions()).toBe(false);
    expect(owner.line()).toBe('$ ab');
  } finally {
    owner.close();
  }
});

test('worker admission publication updates only the SAB gate and cannot retract captured predictions', () => {
  const owner = prompt();
  try {
    owner.key('a');
    owner.echo();
    owner.key('x', true);
    const sab = createPredictionFastPathBuffer(),
      consumer = createPredictionFastPathConsumer(sab);
    createPredictionFastPathWriter(sab).beginEpoch();
    consumer.adoptRequiredEpoch();
    const context = {
      wasmTerminal: {
        viewer: owner.viewer,
        predictionModel: () =>
          new Uint32Array(
            owner.memory.buffer,
            owner.viewer.prediction_model_ptr(),
            owner.viewer.prediction_model_len(),
          ),
      },
      provisionalPreview: createProvisionalPreviewState(),
      observedPredictionAuthorityRevision: -1,
      localPresentationPending: false,
      predictionFastPath: consumer,
      predictionModelThroughInputSeq: 2,
    };
    runInNewContext(
      production('publishPredictionModel', 'predictionArmed', 'revokePaintedPredictions') +
        '\npublishPredictionModel();',
      context,
    );
    expect(createPredictionFastStateReader(sab).visible()).toBe(false);
    expect(owner.visible()).toEqual([2]);
  } finally {
    owner.close();
  }
});

test('discarding queued commands rejects every admission slot and reports the full causal frontier', () => {
  const sab = createPredictionFastPathBuffer(),
    writer = createPredictionFastPathWriter(sab),
    consumer = createPredictionFastPathConsumer(sab);
  writer.beginEpoch();
  consumer.adoptRequiredEpoch();
  expect(writer.writePrintable(2, 97, 1, true)).toBe(true);
  expect(writer.writePrintable(5, 98, 2, false)).toBe(true);
  const rejected: number[] = [];
  const through = runInNewContext(
    `${production('clearQueuedPredictions')}\nclearQueuedPredictions();`,
    {
      predictionFastPath: consumer,
      predictionAdmissionResolver: { reject: (sequence: number) => rejected.push(sequence) },
    },
  );
  expect(through).toBe(5);
  expect(rejected).toEqual([2, 5]);
  expect(consumer.pendingCount()).toBe(0);
});

test('revocation clears unsent preview geometry and requests one local repaint', () => {
  const preview = createProvisionalPreviewState();
  const authority = {
    epoch: 1,
    modelVersion: 2,
    predictionSafe: true,
    predictionVisible: true,
    appendOnly: true,
    cursorVisible: true,
    preeditActive: false,
    col: 2,
    row: 0,
    cols: 20,
    rows: 2,
    inputSeq: 0,
    foreground: 0,
    background: 0,
    cursorShape: 1,
    atlasGeneration: 1,
  };
  expect(
    preview.update({ pointerId: 1, codepoint: 97, epoch: 1, modelVersion: 2 }, authority),
  ).toBe(true);
  const context = {
    provisionalPreview: preview,
    localPresentationPending: false,
    displayEpoch: { renderPending: false },
  };
  runInNewContext(
    `${production('revokePaintedPredictions')}\nrevokePaintedPredictions();`,
    context,
  );
  expect(preview.count()).toBe(0);
  expect(context.localPresentationPending).toBe(true);
  expect(context.displayEpoch.renderPending).toBe(true);
});

test('fresh identical editor authority invalidates already queued pointer model revisions', () => {
  const owner = prompt();
  try {
    for (const character of 'abc') {
      owner.key(character);
      owner.echo();
    }
    const viewer = owner.viewer;
    const sab = createPredictionFastPathBuffer(),
      consumer = createPredictionFastPathConsumer(sab),
      writer = createPredictionFastPathWriter(sab);
    writer.beginEpoch();
    consumer.adoptRequiredEpoch();
    const context = {
      wasmTerminal: {
        viewer,
        memory: owner.memory,
        predictionModel: () =>
          new Uint32Array(
            owner.memory.buffer,
            viewer.prediction_model_ptr(),
            viewer.prediction_model_len(),
          ),
        mouseMode: () => viewer.mouse_mode(),
        presentationRevision: () => viewer.presentation_revision(),
      },
      provisionalPreview: createProvisionalPreviewState(),
      observedPredictionAuthorityRevision: -1,
      localPresentationPending: false,
      predictionFastPath: consumer,
      predictionModelThroughInputSeq: 3,
      graphicsOfferSpaceReleased: false,
      graphicsPresentationDirty: false,
      renderer: null,
      graphicsResidents: new Set(),
      lastMouseMode: viewer.mouse_mode(),
      publishViewerLinks() {},
      perfEnabled: false,
      observedViewerFrames: viewer.applied_frames(),
      observedViewerSnapshots: viewer.applied_snapshots(),
      observedViewerPresentations: viewer.applied_presentations(),
      observedPresentationRevision: viewer.presentation_revision(),
      displayEpoch: { generation: viewer.generation(), renderPending: false },
    };
    runInNewContext(
      production(
        'publishPredictionModel',
        'predictionArmed',
        'observeViewerPresentation',
        'revokePaintedPredictions',
      ),
      context,
    );
    runInNewContext('publishPredictionModel();', context);
    const captured = consumer.modelVersion();
    expect(writer.writeProvisional(1, 120, 1, captured)).toBe(true);
    owner.receive(anchor(), TRANSPORT_CHANNEL_ID.ctrl, 20);
    runInNewContext('observeViewerPresentation(); publishPredictionModel();', context);
    expect(consumer.modelVersion()).toBeGreaterThan(captured);
    const preview = createProvisionalPreviewState();
    const authority = {
      epoch: 1,
      modelVersion: consumer.modelVersion(),
      predictionSafe: true,
      predictionVisible: true,
      appendOnly: true,
      cursorVisible: true,
      preeditActive: false,
      col: 5,
      row: 0,
      cols: 20,
      rows: 2,
      inputSeq: 3,
      foreground: 0,
      background: 0,
      cursorShape: 1,
      atlasGeneration: 1,
    };
    consumer.drainProvisionalPreviews((snapshot) => preview.synchronize(snapshot, authority));
    expect(preview.count()).toBe(0);
  } finally {
    owner.close();
  }
});

test('resize retires the prior viewport model and fences its following captured keys', () => {
  const owner = prompt();
  try {
    owner.key('a');
    owner.echo();
    expect(owner.key('x', true)).toBe(true);
    expect(owner.visible()).toEqual([2]);
    owner.viewer.resize(21, 2);
    expect(owner.viewer.has_predictions()).toBe(false);
    expect(owner.key('y', true)).toBe(false);
  } finally {
    owner.close();
  }
});
