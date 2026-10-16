/**
 * @name Authentication tag compared in variable time
 * @description An HMAC or Poly1305 tag compared with `==` or `PartialEq` returns at the first byte
 *              that differs, which lets a caller recover a valid tag one byte at a time. Verify
 *              with `ring::hmac::verify` or compare with `subtle::ConstantTimeEq::ct_eq`.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 7.4
 * @precision high
 * @id merkur/rust/tag-variable-time-comparison
 * @tags security
 *       external/cwe/cwe-208
 */

import rust
import codeql.rust.dataflow.DataFlow

/** A call that computes an authentication tag. */
class TagComputation extends Call {
  TagComputation() {
    this.getStaticTarget().getCanonicalPath() =
      [
        "ring::hmac::sign", "<ring::hmac::Context>::sign",
        "<poly1305::Poly1305 as universal_hash::UniversalHash>::finalize",
        "<poly1305::Poly1305>::compute_unpadded"
      ]
  }
}

/**
 * Holds if `succ` is the tag `pred` holds in another form: its bytes, a reference to them, a
 * prefix of them or an owned copy. Taint in general is not followed: a tag sent to a peer is the
 * peer's to read, and what is built around it is not the tag.
 */
predicate viewsTag(DataFlow::Node pred, DataFlow::Node succ) {
  succ.asExpr().(RefExpr).getExpr() = pred.asExpr()
  or
  exists(PrefixExpr deref | deref.getOperatorName() = "*" |
    deref.getExpr() = pred.asExpr() and succ.asExpr() = deref
  )
  or
  succ.asExpr().(IndexExpr).getBase() = pred.asExpr()
  or
  exists(MethodCall call |
    call.getTargetName() =
      ["as_ref", "as_slice", "as_bytes", "to_vec", "to_owned", "into", "into_bytes", "into_vec"] and
    call.getReceiver() = pred.asExpr() and
    succ.asExpr() = call
  )
}

/** Holds if `e` is part of an `assert_eq!` or `assert_ne!`, which answers a test, not a peer. */
predicate inAssertion(Expr e) {
  exists(MacroCall assertion |
    assertion.getPath().getSegment().getIdentifier().getText() =
      ["assert_eq", "assert_ne", "debug_assert_eq", "debug_assert_ne"] and
    e.getParentNode+() = assertion.getMacroCallExpansion()
  )
}

/** An operand of `==`, `!=` or a `PartialEq` method, each of which stops at the first difference. */
predicate isVariableTimeOperand(Expr e) {
  (
    exists(BinaryExpr cmp | cmp instanceof EqualsOperation or cmp instanceof NotEqualsOperation |
      e = [cmp.getLhs(), cmp.getRhs()]
    )
    or
    exists(MethodCall call | call.getTargetName() = ["eq", "ne"] |
      e = [call.getReceiver(), call.getPositionalArgument(0)]
    )
  ) and
  not inAssertion(e)
}

module TagComparisonConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node node) { node.asExpr() instanceof TagComputation }

  predicate isSink(DataFlow::Node node) { isVariableTimeOperand(node.asExpr()) }

  predicate isAdditionalFlowStep(DataFlow::Node pred, DataFlow::Node succ) { viewsTag(pred, succ) }

  predicate observeDiffInformedIncrementalMode() { any() }
}

module TagComparisonFlow = DataFlow::Global<TagComparisonConfig>;

import TagComparisonFlow::PathGraph

from TagComparisonFlow::PathNode source, TagComparisonFlow::PathNode sink
where TagComparisonFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "This comparison reads the $@ in variable time.",
  source.getNode(), "authentication tag"
