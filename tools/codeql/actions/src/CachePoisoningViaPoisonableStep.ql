/**
 * @name Cache Poisoning via execution of untrusted code
 * @description The cache can be poisoned by untrusted code, leading to a cache poisoning attack.
 * @kind path-problem
 * @problem.severity error
 * @precision high
 * @security-severity 7.5
 * @id actions/cache-poisoning/poisonable-step
 * @tags actions
 *       security
 *       external/cwe/cwe-349
 */

// CodeQL's query of this id, which the suite replaces, with one condition: a checkout that names
// a head commit only through `github.event.workflow_run` fields is untrusted only on `workflow_run`
// (WorkflowRunFields.qll). The id stays so the alerts this query and the upstream one share keep
// their history.
import actions
import codeql.actions.security.ArtifactPoisoningQuery
import codeql.actions.security.UntrustedCheckoutQuery
import WorkflowRunFields
import codeql.actions.security.CachePoisoningQuery
import codeql.actions.security.PoisonableSteps
import codeql.actions.security.ControlChecks

query predicate edges(AstNode predecessor, AstNode successor) {
  predecessor.(Step).getNextStep() = successor
  or
  checkoutReferenceEdge(predecessor, successor)
}

from
  LocalJob job, Event event, Step source, Step step, string message, string path,
  AstNode untrustedInput, string untrustedInputText
where
  // the job checkouts untrusted code from a pull request or downloads an untrusted artifact
  job.getAStep() = source and
  (
    source instanceof PRHeadCheckoutStep and
    message = "due to privilege checkout of untrusted code from" and
    path = source.(PRHeadCheckoutStep).getPath() and
    untrustedInput = getCheckoutReference(source) and
    untrustedInputText = getCheckoutReferenceText(untrustedInput)
    or
    source instanceof UntrustedArtifactDownloadStep and
    message = "due to downloading" and
    path = source.(UntrustedArtifactDownloadStep).getPath() and
    untrustedInput = source and
    untrustedInputText = "an untrusted artifact"
  ) and
  // a workflow_run field names nothing on any other event
  not emptyOutsideWorkflowRun(source, event) and
  // the checkout/download is not controlled by an access check
  not exists(ControlCheck check |
    check.protects(source, event, ["untrusted-checkout", "artifact-poisoning"])
  ) and
  job.getATriggerEvent() = event and
  // job can be triggered by an external user
  event.isExternallyTriggerable() and
  hasDefaultBranchCacheWriteAccess(job, event) and
  // the job executes checked-out code
  // (The cache specific token can be leaked even for non-privileged workflows)
  source.getAFollowingStep() = step and
  step instanceof PoisonableStep and
  // excluding privileged workflows since they can be exploited in easier circumstances
  not job.isPrivileged()
select step, untrustedInput, step,
  "Potential cache poisoning in the context of the default branch " + message + " $@. ($@).",
  untrustedInput, untrustedInputText, event, event.getName()
