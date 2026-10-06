/**
 * Figure 3's arithmetic: updates travel as four packets and one parity shard,
 * and one loss in a group is rebuilt from the other four.
 */

/** Packets in a group, the parity shard last. */
export const GROUP = 5;

const PARITY = GROUP - 1;

/** The groups the figure shows, newest first, and the ones it keeps counting. */
export const SHOWN = 6;

const KEPT = 400;

export interface Group {
  readonly id: number;
  /** Which of its packets were lost. */
  readonly lost: readonly boolean[];
}

/** What became of a group: whole, parity alone lost, one packet rebuilt, or left to the next update. */
export type Outcome = 'arrived' | 'parity' | 'rebuilt' | 'fallback';

export interface Link {
  readonly playing: boolean;
  /** The chance a packet is lost, in percent. */
  readonly loss: number;
  readonly next: number;
  /** Newest first. */
  readonly groups: readonly Group[];
}

/** The link as the figure opens: six groups already through, one loss in ten. */
export function openLink(playing: boolean): Link {
  const lost = [
    [0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 1, 0, 1, 0],
    [0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
  ];

  return {
    playing,
    loss: 10,
    next: 1046,
    groups: lost.map((group, index) => ({ id: 1045 - index, lost: group.map((bit) => bit === 1) })),
  };
}

export function lostPackets(group: Group): number[] {
  return group.lost.flatMap((lost, index) => (lost ? [index] : []));
}

export function outcome(group: Group): Outcome {
  const lost = lostPackets(group);

  if (lost.length === 0) return 'arrived';

  if (lost.length === 1) return lost[0] === PARITY ? 'parity' : 'rebuilt';

  return 'fallback';
}

/** What a reader calls a packet: its number, or P for the parity shard. */
export function packetName(index: number): string {
  return index === PARITY ? 'P' : String(index + 1);
}

export function describe(group: Group): string {
  const lost = lostPackets(group);
  const result = outcome(group);

  if (result === 'arrived') return 'arrived';

  if (result === 'parity') return 'parity lost · nothing to rebuild';

  if (result === 'rebuilt') return `packet ${packetName(lost[0] ?? 0)} rebuilt on arrival`;

  return `packets ${lost.map(packetName).join(', ')} lost · next update covers it`;
}

/** The link after one more group has crossed it, each packet lost when `chance()` says so. */
export function send(link: Link, chance: () => number): Link {
  const lost = Array.from({ length: GROUP }, () => chance() < link.loss / 100);

  return {
    ...link,
    next: link.next + 1,
    groups: [{ id: link.next, lost }, ...link.groups].slice(0, KEPT),
  };
}

/** The link with one packet of one group lost, or restored; it stops playing. */
export function toggle(link: Link, id: number, packet: number): Link {
  return {
    ...link,
    playing: false,
    groups: link.groups.map((group) =>
      group.id === id
        ? { ...group, lost: group.lost.map((lost, index) => (index === packet ? !lost : lost)) }
        : group,
    ),
  };
}

/** What the link has carried so far: its groups, and how each loss ended. */
export interface Tally {
  readonly groups: number;
  readonly rebuilt: number;
  readonly fallback: number;
}

export function tally(link: Link): Tally {
  let rebuilt = 0;
  let fallback = 0;

  for (const group of link.groups) {
    const result = outcome(group);

    if (result === 'rebuilt') rebuilt += 1;
    else if (result === 'fallback') fallback += 1;
  }

  return { groups: link.groups.length, rebuilt, fallback };
}
