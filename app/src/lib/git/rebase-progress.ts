import { RebaseInternalState } from '../../models/rebase'

/**
 * Turn the rebase files Git writes under `.git` into the state Desktop shows.
 *
 * `null` means that file is absent. An empty file is still present: a rebase
 * is in progress when `REBASE_HEAD` exists, even before the other files can
 * be parsed.
 */
export function rebaseInternalStateFromFiles(
  rebaseHead: string | null,
  originalBranchTip: string | null,
  targetBranch: string | null,
  baseBranchTip: string | null
): RebaseInternalState | null {
  if (
    rebaseHead === null ||
    originalBranchTip === null ||
    targetBranch === null ||
    baseBranchTip === null
  ) {
    return null
  }

  return {
    originalBranchTip: originalBranchTip.trim(),
    targetBranch: targetBranch.startsWith('refs/heads/')
      ? targetBranch.substring(11).trim()
      : targetBranch,
    baseBranchTip: baseBranchTip.trim(),
  }
}
