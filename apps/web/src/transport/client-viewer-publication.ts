/** Native mailbox custody; Rust owns the payload and display lineage. */
export function isCurrentViewerPublication(
  value: { readonly lineage: number; readonly frameFenceToken: number },
  lineage: number,
  frameFenceToken: number,
): boolean {
  return isCurrentViewerStamp(value.lineage, value.frameFenceToken, lineage, frameFenceToken);
}

/**
 * The same custody for a viewer-output ring entry, which carries its lineage
 * and fence as two words rather than as a message's fields.
 */
export function isCurrentViewerStamp(
  stampedLineage: number,
  stampedFrameFenceToken: number,
  lineage: number,
  frameFenceToken: number,
): boolean {
  return (
    lineage > 0 &&
    frameFenceToken > 0 &&
    stampedLineage === lineage &&
    stampedFrameFenceToken === frameFenceToken
  );
}
