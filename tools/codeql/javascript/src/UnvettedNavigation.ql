/**
 * @name Terminal-supplied URL navigates without the scheme check
 * @description Workers hand the main thread what the terminal and the daemon sent. A URL from that
 *              data opens a window or moves the page only after `openableUrl` admits it, so a
 *              `javascript:`, `data:` or `file:` target stays inert.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 6.1
 * @precision high
 * @id merkur/js/unvetted-navigation
 * @tags security
 *       external/cwe/cwe-079
 *       external/cwe/cwe-601
 */

import javascript

/** A function that handles `message` events, set as `onmessage` or added as a listener. */
class MessageHandler extends DataFlow::FunctionNode {
  MessageHandler() {
    exists(DataFlow::PropWrite write |
      write.getPropertyName() = "onmessage" and this.flowsTo(write.getRhs())
    )
    or
    exists(DataFlow::MethodCallNode listen |
      listen.getMethodName() = "addEventListener" and
      listen.getArgument(0).mayHaveStringValue("message") and
      this.flowsTo(listen.getArgument(1))
    )
  }
}

/** What a worker or port posted: the `data` of a handled `message` event. */
class PostedData extends DataFlow::Node {
  PostedData() { this = any(MessageHandler handler).getParameter(0).getAPropertyRead("data") }
}

/** A target a window opens or the page moves to. */
class NavigationTarget extends DataFlow::Node {
  NavigationTarget() {
    this = DataFlow::globalVarRef("open").getACall().getArgument(0)
    or
    this = DataFlow::globalVarRef("location").getAMemberCall(["assign", "replace"]).getArgument(0)
    or
    exists(DataFlow::PropWrite write | this = write.getRhs() |
      write = DataFlow::globalVarRef("location").getAPropertyWrite("href")
      or
      write = DataFlow::globalVarRef(["window", "document"]).getAPropertyWrite("location")
    )
  }
}

/** The one check that admits a target: `openableUrl`, which returns only an http(s) URL. */
class SchemeCheck extends DataFlow::CallNode {
  SchemeCheck() { this.getACallee().getName() = "openableUrl" }
}

module NavigationConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node node) { node instanceof PostedData }

  predicate isSink(DataFlow::Node node) { node instanceof NavigationTarget }

  predicate isBarrier(DataFlow::Node node) { node instanceof SchemeCheck }
}

module NavigationFlow = TaintTracking::Global<NavigationConfig>;

import NavigationFlow::PathGraph

from NavigationFlow::PathNode source, NavigationFlow::PathNode sink
where NavigationFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "This navigation target comes from $@ without `openableUrl`.",
  source.getNode(), "posted terminal data"
