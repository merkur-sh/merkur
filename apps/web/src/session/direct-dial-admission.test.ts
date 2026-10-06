import { describe, expect, test } from 'bun:test';
import { createDirectDialAdmission } from './direct-dial-admission';

describe('page-owned direct dial admission', () => {
  test('an in-flight endpoint cannot be dialled twice, and only a failed handshake spends it', () => {
    const admission = createDirectDialAdmission();
    const ready = admission.claim('ready');
    expect(ready).not.toBeNull();
    expect(admission.claim('ready')).toBeNull();
    // A handshake that succeeded is not charged whatever becomes of the path:
    // one that later dies may be dialled again.
    ready?.settle('ready');
    expect(admission.claim('ready')).not.toBeNull();

    admission.claim('failed')?.settle('failed');
    expect(admission.claim('failed')).toBeNull();

    admission.claim('unused')?.settle('unused');
    expect(admission.claim('unused')).not.toBeNull();
    expect(admission.claim('different-certificate-or-port')).not.toBeNull();
  });

  test('the first outcome decides', () => {
    const admission = createDirectDialAdmission();
    const claim = admission.claim('endpoint');
    claim?.settle('ready');
    claim?.settle('failed');
    expect(admission.claim('endpoint')).not.toBeNull();
  });

  test('another proven address is another network, and a return is a new visit', () => {
    const admission = createDirectDialAdmission();
    expect(admission.observePath('192.0.2.1')).toBe(true);
    admission.claim('failed')?.settle('failed');
    expect(admission.observePath('192.0.2.1')).toBe(false);
    expect(admission.claim('failed')).toBeNull();

    expect(admission.observePath('198.51.100.7')).toBe(true);
    const onB = admission.claim('failed');
    expect(onB).not.toBeNull();
    onB?.settle('failed');

    // Back on the first network: what failed there before says nothing now.
    expect(admission.observePath('192.0.2.1')).toBe(true);
    expect(admission.claim('failed')).not.toBeNull();
  });

  test('a late outcome settles into the visit it was claimed in', () => {
    const admission = createDirectDialAdmission();
    admission.observePath('192.0.2.1');
    const onA = admission.claim('endpoint');
    admission.observePath('198.51.100.7');
    const onB = admission.claim('endpoint');
    expect(onB).not.toBeNull();
    onA?.settle('failed');
    onB?.settle('ready');
    expect(admission.claim('endpoint')).not.toBeNull();
  });
});
