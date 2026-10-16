/**
 * @name Unwrapped secret reaches a log, error, span or response
 * @description `Redacted.value` takes a secret out of the wrapper that keeps it out of logs,
 *              errors and spans. The unwrapped value may reach the credential it authenticates,
 *              never a record that outlives the request.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 7.5
 * @precision high
 * @id merkur/js/redacted-value-exposure
 * @tags security
 *       external/cwe/cwe-209
 *       external/cwe/cwe-532
 */

import javascript

/** The `Redacted` module of Effect, imported whole or as the `Redacted` member of `effect`. */
API::Node redactedModule() {
  result = API::moduleImport("effect").getMember("Redacted")
  or
  result = API::moduleImport("effect/Redacted")
}

/** A method of `@merkur/logger`'s `Logger` that writes a record. */
class LoggerWrite extends DataFlow::MethodCallNode {
  LoggerWrite() {
    this.getMethodName() = ["info", "warn", "error", "effect"] and
    (
      this =
        API::moduleImport("@merkur/logger")
            .getMember("createLogger")
            .getReturn()
            .getMember(this.getMethodName())
            .getACall()
      or
      this.getReceiver().hasUnderlyingType("@merkur/logger", "Logger")
    )
  }
}

/**
 * A class that is `Error`, an Effect error, or derives from one. A TypeScript superclass with type
 * arguments (`Data.TaggedError('Tag')<Fields>`) flows from the call it instantiates.
 */
predicate isErrorClass(DataFlow::ClassNode cls) {
  cls.getASuperClassNode().getALocalSource() = DataFlow::globalVarRef("Error")
  or
  cls.getASuperClassNode().getALocalSource() =
    API::moduleImport("effect")
        .getMember(["Data", "Schema"])
        .getMember(["Error", "TaggedError"])
        .getACall()
  or
  isErrorClass(cls.getADirectSuperClass())
}

/** An argument of an error construction. */
DataFlow::Node errorArgument() {
  exists(DataFlow::NewNode construction |
    construction = DataFlow::globalVarRef(["Error", "TypeError", "RangeError"]).getAnInstantiation()
    or
    exists(DataFlow::ClassNode cls | isErrorClass(cls) and construction = cls.getAnInstantiation())
  |
    result = construction.getAnArgument()
  )
}

/** An argument of a call that writes a log, a span attribute, a failure or a response. */
DataFlow::Node exposedArgument() {
  result = any(LoggerWrite write).getAnArgument()
  or
  result =
    API::moduleImport("effect")
        .getMember("Effect")
        .getMember([
            "log", "logTrace", "logDebug", "logInfo", "logWarning", "logError", "logFatal",
            "annotateLogs", "annotateCurrentSpan", "fail", "die", "withSpan", "fn", "makeSpan",
            "useSpan"
          ])
        .getACall()
        .getAnArgument()
  or
  result = errorArgument()
  or
  result = DataFlow::globalVarRef("Response").getAnInstantiation().getArgument(0)
  or
  result = DataFlow::globalVarRef("Response").getAMemberCall("json").getArgument(0)
  or
  result = API::moduleImport("elysia").getMember("status").getACall().getArgument(1)
}

/** An exposed argument, or a value an object literal written there holds at any depth. */
DataFlow::Node exposedValue() {
  result = exposedArgument()
  or
  result = exposedValue().getALocalSource().(DataFlow::ObjectLiteralNode).getAPropertyWrite().getRhs()
}

/** A record or reply that outlives the request: a log, a span attribute, a failure or a response. */
class Exposure extends DataFlow::Node {
  Exposure() { this = exposedValue() }
}

/** A hash or HMAC object, as `createHash` or `createHmac` returns it and as each `update` does. */
API::Node hash() {
  result = API::moduleImport(["crypto", "node:crypto"]).getMember(["createHmac", "createHash"]).getReturn()
  or
  result = hash().getMember("update").getReturn()
}

/** The output of a hash or keyed hash, which reveals nothing of the secret that went in. */
class Digest extends DataFlow::Node {
  Digest() { this = hash().getMember("digest").getACall() }
}

module RedactedConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node node) {
    node = redactedModule().getMember("value").getACall()
  }

  predicate isSink(DataFlow::Node node) { node instanceof Exposure }

  predicate isBarrier(DataFlow::Node node) { node instanceof Digest }
}

module RedactedFlow = TaintTracking::Global<RedactedConfig>;

import RedactedFlow::PathGraph

from RedactedFlow::PathNode source, RedactedFlow::PathNode sink
where RedactedFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "This record holds the $@.", source.getNode(),
  "unwrapped secret"
