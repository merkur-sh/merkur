/**
 * @name Zeroized secret copied into memory that is never wiped
 * @description A copy of a `Zeroizing` value made with `to_vec`, `to_owned`, `clone`, `From` or
 *              `copy_from_slice` outlives the wipe the wrapper performs, unless the copy is itself
 *              held in `Zeroizing`.
 * @kind path-problem
 * @problem.severity warning
 * @security-severity 5.5
 * @precision high
 * @id merkur/rust/zeroizing-copy
 * @tags security
 *       external/cwe/cwe-226
 *       external/cwe/cwe-316
 */

import rust
import codeql.rust.dataflow.DataFlow
import codeql.rust.dataflow.TaintTracking
import Zeroizing

/** Holds if `copy` is wrapped in `Zeroizing` where it is made. */
predicate isWrapped(Expr copy) { exists(Call wrap | isZeroizing(wrap) | wrap.getAnArgument() = copy) }

/** The value a copying call reads, where the copy it makes is not wiped. */
predicate isUnwipedCopySource(Expr copied) {
  exists(MethodCall call |
    call.getTargetName() =
      ["to_vec", "to_owned", "to_string", "clone", "into_owned", "into_vec", "into_boxed_slice"] and
    copied = call.getReceiver() and
    not isZeroizing(call) and
    not isWrapped(call)
  )
  or
  // A generic `From` impl resolves to no single target, so the constructor is named by its path.
  exists(CallExpr call |
    call.getFunction().(PathExpr).getPath().getSegment().getIdentifier().getText() =
      ["from", "copy_from_slice"] and
    isOwnedBuffer(call) and
    copied = call.getArgList().getArg(0) and
    not isWrapped(call)
  )
  or
  exists(MethodCall call |
    call.getTargetName() = ["copy_from_slice", "clone_from_slice", "extend_from_slice"] and
    copied = call.getPositionalArgument(0) and
    not isZeroizing(call.getReceiver())
  )
}

module ZeroizingCopyConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node node) { isZeroizing(node.asExpr()) }

  predicate isSink(DataFlow::Node node) { isUnwipedCopySource(node.asExpr()) }

  predicate isBarrier(DataFlow::Node node) { isPublicMeasure(node) }

  predicate isBarrierIn(DataFlow::Node node) { isSource(node) }

  predicate isAdditionalFlowStep(DataFlow::Node pred, DataFlow::Node succ) {
    readsSecret(pred, succ)
  }

  predicate observeDiffInformedIncrementalMode() { any() }
}

module ZeroizingCopyFlow = TaintTracking::Global<ZeroizingCopyConfig>;

import ZeroizingCopyFlow::PathGraph

from ZeroizingCopyFlow::PathNode source, ZeroizingCopyFlow::PathNode sink
where ZeroizingCopyFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "This copy of the $@ is never wiped.", source.getNode(),
  "zeroized secret"
