import { Repository } from '../../models/repository'
import { RebaseInternalState } from '../../models/rebase'
import { readSshFileBundle } from '../ssh/ssh-remote-git'
import { rebaseInternalStateFromFiles } from './rebase-progress'
import { remoteGitDirectory } from './repository-files'

const OperationStateFiles = [
  'MERGE_HEAD',
  'SQUASH_MSG',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'rebase-merge/orig-head',
  'rebase-merge/head-name',
  'rebase-merge/onto',
] as const

type OperationStateFile = typeof OperationStateFiles[number]

export interface ISshOperationState {
  readonly mergeHeadFound: boolean
  readonly squashMsgFound: boolean
  readonly isCherryPickingHeadFound: boolean
  readonly rebaseInternalState: RebaseInternalState | null
}

/**
 * Read the git-directory markers status needs in one SSH command.
 *
 * A normal refresh otherwise opens a connection per file. On Windows that
 * connection is not multiplexed.
 */
export async function readSshOperationState(
  repository: Repository
): Promise<ISshOperationState> {
  const remote = repository.sshRemote
  const directory = remoteGitDirectory(repository)
  if (remote === null || directory === null) {
    return {
      mergeHeadFound: false,
      squashMsgFound: false,
      isCherryPickingHeadFound: false,
      rebaseInternalState: null,
    }
  }

  const bundle = await readSshFileBundle(remote, directory, OperationStateFiles)
  const text = (name: OperationStateFile) => {
    const value = bundle.get(name)
    return value == null ? null : value.toString('utf8')
  }

  return {
    mergeHeadFound: text('MERGE_HEAD') !== null,
    squashMsgFound: text('SQUASH_MSG') !== null,
    isCherryPickingHeadFound: text('CHERRY_PICK_HEAD') !== null,
    rebaseInternalState: rebaseInternalStateFromFiles(
      text('REBASE_HEAD'),
      text('rebase-merge/orig-head'),
      text('rebase-merge/head-name'),
      text('rebase-merge/onto')
    ),
  }
}
