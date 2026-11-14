/**
 * @name Checkout of untrusted code in a non-privileged context
 * @description Checking out and running the build script from a fork executes untrusted code. Even in a
 *              non-privileged workflow, this can be abused, for example to compromise self-hosted runners
 *              or to poison caches and artifacts that are later consumed by privileged workflows.
 * @kind problem
 * @problem.severity warning
 * @precision medium
 * @security-severity 5.0
 * @id actions/untrusted-checkout/medium
 * @tags actions
 *       security
 *       external/cwe/cwe-829
 */

// CodeQL's query of this id, which the suite replaces, with one condition: the checkout is
// untrusted on some event its job runs on. A reference that names a head commit only through
// `github.event.workflow_run` fields is untrusted only on `workflow_run` (WorkflowRunFields.qll),
// and there only without an access check that vouches for it, as the privileged-context queries
// already require. The id stays so the alerts this query and the upstream one share keep their
// history.
import actions
import codeql.actions.security.UntrustedCheckoutQuery
import codeql.actions.security.ControlChecks
import WorkflowRunFields

from PRHeadCheckoutStep checkout
where
  // the checkout occurs in a non-privileged context
  inNonPrivilegedContext(checkout) and
  // on some event its job runs on, the reference names a commit no access check vouches for
  exists(Event event |
    event = checkout.getEnclosingJob().getATriggerEvent() and
    not emptyOutsideWorkflowRun(checkout, event) and
    not exists(ControlCheck check | check.protects(checkout, event, "untrusted-checkout"))
  )
select checkout, "Potential unsafe checkout of untrusted pull request on non-privileged workflow."
