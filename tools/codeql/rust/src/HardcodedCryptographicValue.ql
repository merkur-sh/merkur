/**
 * @name Hard-coded cryptographic value
 * @description Using hard-coded keys, passwords, salts or initialization
 *              vectors is not secure.
 * @kind path-problem
 * @problem.severity warning
 * @security-severity 9.8
 * @precision high
 * @id rust/hard-coded-cryptographic-value
 * @tags security
 *       external/cwe/cwe-259
 *       external/cwe/cwe-321
 *       external/cwe/cwe-798
 *       external/cwe/cwe-1204
 */

// CodeQL's query of this id, which the suite replaces, with one barrier: a constant-initialised
// buffer that the next statement overwrites whole never reaches a use. The id stays so the alerts
// this query and the upstream one share keep their history.
import rust
import codeql.rust.security.HardcodedCryptographicValueExtensions
import codeql.rust.dataflow.DataFlow
import codeql.rust.dataflow.TaintTracking

/** Holds if `outer` is `inner` or a method chain on it, as in `rng.fill(&mut b).map_err(f)`. */
predicate receiverChain(Expr outer, Expr inner) {
  outer = inner
  or
  receiverChain(outer.(MethodCall).getReceiver(), inner)
}

/**
 * Holds if `write`, a statement's whole expression, writes every byte of `buffer` or leaves the
 * function. `copy_from_slice` panics unless the lengths match; a random fill's error has to reach
 * `?`, since a discarded one leaves the constant in place.
 */
predicate overwritesWhole(Expr write, Variable buffer) {
  exists(MethodCall copy | copy = write |
    copy.getStaticTarget().getCanonicalPath() = "<[]>::copy_from_slice" and
    copy.getReceiver() = buffer.getAnAccess()
  )
  or
  exists(Call fill, RefExpr target |
    target = fill.getPositionalArgument(_) and
    target.isMut() and
    target.getExpr() = buffer.getAnAccess()
  |
    fill.getStaticTarget().getCanonicalPath() =
      ["<ring::rand::SecureRandom>::fill", "<_ as ring::rand::SecureRandom>::fill"] and
    receiverChain(write.(TryExpr).getExpr(), fill)
    or
    // Infallible: the trait fills from the platform's CSPRNG or a test's seeded stream.
    fill.getStaticTarget().getCanonicalPath() = "<merkur_client::Entropy>::fill" and
    write = fill
  )
}

/** Holds if `init` initialises a `let` binding that the next statement overwrites whole. */
predicate overwrittenBeforeUse(Expr init) {
  exists(StmtList block, int i, LetStmt let, Variable buffer, ExprStmt next |
    block.getStatement(i) = let and
    block.getStatement(i + 1) = next and
    let.getInitializer() = init and
    let.getPat() = buffer.getPat() and
    overwritesWhole(next.getExpr(), buffer)
  )
}

module HardcodedCryptographicValueConfig implements DataFlow::ConfigSig {
  import HardcodedCryptographicValue

  predicate isSource(DataFlow::Node source) { source instanceof Source }

  predicate isSink(DataFlow::Node sink) { sink instanceof Sink }

  predicate isBarrier(DataFlow::Node barrier) {
    barrier instanceof Barrier
    or
    overwrittenBeforeUse(barrier.asExpr())
  }

  // Sources and sinks bound the flow so each path reports its closest constant and use.
  predicate isBarrierIn(DataFlow::Node node) { isSource(node) }

  predicate isBarrierOut(DataFlow::Node node) { isSink(node) }
}

module HardcodedCryptographicValueFlow = TaintTracking::Global<HardcodedCryptographicValueConfig>;

import HardcodedCryptographicValueFlow::PathGraph

from
  HardcodedCryptographicValueFlow::PathNode source, HardcodedCryptographicValueFlow::PathNode sink
where HardcodedCryptographicValueFlow::flowPath(source, sink)
select source.getNode(), source, sink, "This hard-coded value is used as $@.", sink,
  sink.getNode().(HardcodedCryptographicValueConfig::Sink).getKind().getDescription()
