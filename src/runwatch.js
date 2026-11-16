// Which ComfyUI run does a "finished" event belong to? generateOnce() creates its waiter BEFORE the workflow is queued (the capture takes a moment),
// so the "execution_success" of the PREVIOUS run (tile 1, previous view, ...) can arrive while the next waiter already exists. Without this check
// that late event started the "no result" countdown of the new run and aborted it ("The workflow finished but produced no new result").

/** an execution_start event arrived: the first waiter that has no prompt yet owns it */
export function adoptStart(waiter, promptId) {
  if (waiter && !waiter.promptId) waiter.promptId = promptId || '?';
}

/** true if an execution_success (promptId may be undefined) should be counted for this waiter.
 *  startSeen = the frontend delivers execution_start events at all (otherwise keep the old behaviour). */
export function successBelongsTo(waiter, startSeen, promptId) {
  if (!waiter) return false;
  if (!startSeen) return true;
  if (!waiter.promptId) return false;                       // the new run has not started yet: this is the end of an older one
  if (promptId && waiter.promptId !== '?' && promptId !== waiter.promptId) return false;
  return true;
}
