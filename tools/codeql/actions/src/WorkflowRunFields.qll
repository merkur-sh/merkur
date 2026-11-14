/**
 * GitHub fills `github.event` with the payload of the event that started the run, so on any event
 * but `workflow_run` every `github.event.workflow_run` field is empty. A checkout whose reference
 * names a head commit or branch only through those fields checks out, on every other event, what
 * the rest of its expression names: `github.event.workflow_run.head_sha || github.sha` is
 * `github.sha` on a schedule. The upstream queries take the field for an attacker's commit whatever
 * the event; the queries here hold it untrusted only on `workflow_run`, where it is filled.
 */

import actions
import codeql.actions.security.UntrustedCheckoutQuery

/**
 * Holds if `event` is not `workflow_run` and `checkout`'s reference names a pull request, head
 * commit or head branch only through `github.event.workflow_run` fields.
 */
predicate emptyOutsideWorkflowRun(PRHeadCheckoutStep checkout, Event event) {
  not event.getName() = "workflow_run" and
  exists(string reference, string rest |
    reference = getCheckoutReferenceText(getCheckoutReference(checkout)) and
    reference.regexpMatch("(?s).*\\bgithub\\.event\\.workflow_run\\..*") and
    rest = reference.regexpReplaceAll("\\bgithub\\.event\\.workflow_run\\.[A-Za-z0-9_.]+", "") and
    not containsHeadSHA(rest) and
    not containsHeadRef(rest) and
    not containsPullRequestNumber(rest)
  )
}
