/**
 * @name Zeroized secret compared in variable time
 * @description `==` and `PartialEq::eq` return at the first byte that differs, so the time a
 *              comparison takes tells a caller how much of a guess was right. A secret held in
 *              `Zeroizing` is compared with `subtle::ConstantTimeEq::ct_eq`.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 7.4
 * @precision high
 * @id merkur/rust/secret-variable-time-comparison
 * @tags security
 *       external/cwe/cwe-208
 */

import rust
import codeql.rust.dataflow.DataFlow
import codeql.rust.dataflow.TaintTracking
import Zeroizing

/** An operand of `==`, `!=` or a `PartialEq` method, each of which stops at the first difference. */
predicate isVariableTimeOperand(Expr e) {
  exists(BinaryExpr cmp | cmp instanceof EqualsOperation or cmp instanceof NotEqualsOperation |
    e = [cmp.getLhs(), cmp.getRhs()]
  )
  or
  exists(MethodCall call | call.getTargetName() = ["eq", "ne"] |
    e = [call.getReceiver(), call.getPositionalArgument(0)]
  )
}

module SecretComparisonConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node node) { isZeroizing(node.asExpr()) }

  predicate isSink(DataFlow::Node node) { isVariableTimeOperand(node.asExpr()) }

  predicate isBarrier(DataFlow::Node node) { isPublicMeasure(node) }

  /** The closest secret to a comparison is reported, not every value it was read from. */
  predicate isBarrierIn(DataFlow::Node node) { isSource(node) }

  predicate isAdditionalFlowStep(DataFlow::Node pred, DataFlow::Node succ) {
    readsSecret(pred, succ)
  }

  predicate observeDiffInformedIncrementalMode() { any() }
}

module SecretComparisonFlow = TaintTracking::Global<SecretComparisonConfig>;

import SecretComparisonFlow::PathGraph

from SecretComparisonFlow::PathNode source, SecretComparisonFlow::PathNode sink
where SecretComparisonFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "This comparison reads the $@ in variable time.",
  source.getNode(), "zeroized secret"
