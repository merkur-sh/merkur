/**
 * @name Authentication tag compared in variable time
 * @description An HMAC tag compared with `===`, `==` or `Buffer.equals` returns as soon as a
 *              byte differs, which lets a caller recover a valid tag one byte at a time. Compare
 *              tags with `timingSafeEqual`.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 7.4
 * @precision high
 * @id merkur/js/mac-non-constant-time-comparison
 * @tags security
 *       external/cwe/cwe-208
 */

import javascript

/** A Node `crypto` export. */
API::Node nodeCrypto(string name) {
  result = API::moduleImport(["crypto", "node:crypto"]).getMember(name)
}

/** An HMAC object, as `createHmac` returns it and as each `update` returns it again. */
API::Node hmac() {
  result = nodeCrypto("createHmac").getReturn()
  or
  result = hmac().getMember("update").getReturn()
}

/** An HMAC tag: the digest of a keyed hash, or a WebCrypto signature. */
class AuthenticationTag extends DataFlow::Node {
  AuthenticationTag() {
    this = hmac().getMember("digest").getACall()
    or
    this = DataFlow::globalVarRef("crypto").getAPropertyRead("subtle").getAMemberCall("sign")
  }
}

/** An operand of a comparison that stops at the first differing byte. */
class VariableTimeOperand extends DataFlow::Node {
  VariableTimeOperand() {
    this = DataFlow::valueNode(any(EqualityTest test).getAnOperand())
    or
    exists(DataFlow::MethodCallNode equals | equals.getMethodName() = "equals" |
      this = equals.getReceiver() or this = equals.getArgument(0)
    )
    or
    this = DataFlow::globalVarRef("Buffer").getAMemberCall("compare").getAnArgument()
  }
}

/**
 * Holds if `succ` is `pred` in another encoding: the same tag as a string, a buffer or a byte
 * array. Taint in general is not followed: a tag written into an issued token is the holder's to
 * read, and the parts of that token after a split are not the tag.
 */
predicate reencodes(DataFlow::Node pred, DataFlow::Node succ) {
  exists(DataFlow::MethodCallNode call |
    call.getMethodName() = ["toString", "toLowerCase", "toUpperCase"] and
    pred = call.getReceiver() and
    succ = call
  )
  or
  exists(DataFlow::InvokeNode call |
    call = DataFlow::globalVarRef("Buffer").getAMemberCall("from") or
    call = DataFlow::globalVarRef("Uint8Array").getAnInstantiation()
  |
    pred = call.getArgument(0) and succ = call
  )
}

module TagConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node node) { node instanceof AuthenticationTag }

  predicate isSink(DataFlow::Node node) { node instanceof VariableTimeOperand }

  predicate isAdditionalFlowStep(DataFlow::Node pred, DataFlow::Node succ) { reencodes(pred, succ) }
}

module TagFlow = DataFlow::Global<TagConfig>;

import TagFlow::PathGraph

from TagFlow::PathNode source, TagFlow::PathNode sink
where TagFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "This comparison reads the $@ in variable time.",
  source.getNode(), "authentication tag"
