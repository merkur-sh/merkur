import { describe, expect, test } from 'bun:test';
import { createDirectDialAdmission } from './direct-dial-admission';

describe('page-owned direct dial admission', () => {
  test('an in-flight endpoint cannot be dialled twice, and only a failed handshake spends it', () => {
    const admission = createDirectDialAdmission();
    const ready = admission.claim('ready', 0);
    expect(ready).not.toBeNull();
    expect(admission.claim('ready', 0)).toBeNull();
    // A handshake that succeeded is not charged whatever becomes of the path:
    // one that later dies may be dialled again.
    ready?.settle('ready');
    expect(admission.claim('ready', 0)).not.toBeNull();

    admission.claim('failed', 0)?.settle('failed');
    expect(admission.claim('failed', 0)).toBeNull();

    admission.claim('unused', 0)?.settle('unused');
    expect(admission.claim('unused', 0)).not.toBeNull();
    expect(admission.claim('different-certificate-or-port', 0)).not.toBeNull();
  });

  test('new allocation evidence rearms a failed tuple without overlapping constructors', () => {
    const admission = createDirectDialAdmission();
    const requested = admission.claim('endpoint', 0);
    expect(admission.claim('endpoint', 41)).toBeNull();
    requested?.settle('failed');
    expect(admission.claim('endpoint', 0)).toBeNull();
    const prepared = admission.claim('endpoint', 41);
    expect(prepared).not.toBeNull();
    expect(admission.claim('endpoint', 42)).toBeNull();
    prepared?.settle('failed');
    expect(admission.claim('endpoint', 41)).toBeNull();
    expect(admission.claim('endpoint', 42)).not.toBeNull();
  });

  test('the first outcome decides', () => {
    const admission = createDirectDialAdmission();
    const claim = admission.claim('endpoint', 0);
    claim?.settle('ready');
    claim?.settle('failed');
    expect(admission.claim('endpoint', 0)).not.toBeNull();
  });

  test('another proven address is another network, and a return is a new visit', () => {
    const admission = createDirectDialAdmission();
    expect(admission.observePath('192.0.2.1')).toBe(true);
    admission.claim('failed', 0)?.settle('failed');
    expect(admission.observePath('192.0.2.1')).toBe(false);
    expect(admission.claim('failed', 0)).toBeNull();

    expect(admission.observePath('198.51.100.7')).toBe(true);
    const onB = admission.claim('failed', 0);
    expect(onB).not.toBeNull();
    onB?.settle('failed');

    // Back on the first network: what failed there before says nothing now.
    expect(admission.observePath('192.0.2.1')).toBe(true);
    expect(admission.claim('failed', 0)).not.toBeNull();
  });

  test('a late outcome settles into the visit it was claimed in', () => {
    const admission = createDirectDialAdmission();
    admission.observePath('192.0.2.1');
    const onA = admission.claim('endpoint', 0);
    admission.observePath('198.51.100.7');
    const onB = admission.claim('endpoint', 0);
    expect(onB).not.toBeNull();
    onA?.settle('failed');
    onB?.settle('ready');
    expect(admission.claim('endpoint', 0)).not.toBeNull();
  });
});
