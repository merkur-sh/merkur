/**
 * @name Uncontrolled program or raw shell text in a Bun process
 * @description A user-provided value chooses the program `Bun.spawn` runs, or reaches a `Bun.$`
 *              command as `{ raw }`, the one interpolation Bun does not escape.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 9.8
 * @precision high
 * @id merkur/js/bun-command-injection
 * @tags security
 *       external/cwe/cwe-078
 *       external/cwe/cwe-088
 */

import javascript

/** Bun's own export `name`, read from the `Bun` global or imported from `bun`. */
DataFlow::SourceNode bunExport(string name) {
  result = DataFlow::globalVarRef("Bun").getAPropertyRead(name)
  or
  result = DataFlow::moduleMember("bun", name)
}

/**
 * The program a `Bun.spawn` or `Bun.spawnSync` call runs: the first element of its command array.
 * The other elements are arguments, which no shell reads.
 */
class SpawnedProgram extends DataFlow::Node {
  SpawnedProgram() {
    exists(DataFlow::CallNode spawn, DataFlow::ArrayCreationNode command |
      spawn = bunExport(["spawn", "spawnSync"]).getACall() and
      (
        command.flowsTo(spawn.getArgument(0)) or
        command.flowsTo(spawn.getOptionArgument(0, "cmd"))
      ) and
      this = command.getElement(0)
    )
  }
}

/** A value interpolated into a `Bun.$` command as `{ raw: value }`. */
class RawShellText extends DataFlow::Node {
  RawShellText() {
    exists(TaggedTemplateExpr command, DataFlow::ObjectLiteralNode raw |
      bunExport("$").flowsToExpr(command.getTag()) and
      raw.flowsToExpr(command.getTemplate().getAnElement()) and
      this = raw.getAPropertyWrite("raw").getRhs()
    )
  }
}

module BunCommandConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node node) { node instanceof ActiveThreatModelSource }

  predicate isSink(DataFlow::Node node) {
    node instanceof SpawnedProgram or node instanceof RawShellText
  }
}

module BunCommandFlow = TaintTracking::Global<BunCommandConfig>;

import BunCommandFlow::PathGraph

from BunCommandFlow::PathNode source, BunCommandFlow::PathNode sink
where BunCommandFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "This command depends on a $@.", source.getNode(),
  "user-provided value"
