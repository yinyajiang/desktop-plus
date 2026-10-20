import { access } from 'fs/promises'
import constant from 'lodash/constant'
import { isSshRemotePath } from './ssh/ssh-remote-location'

/**
 * Returns a value indicating whether or not the provided path exists (as in
 * whether it's visible to the current process or not).
 *
 * SSH repository identifiers are not local paths. Existence is `test -e` on
 * the remote host, and a connection failure is reported as not existing so
 * refresh can mark the repository missing instead of throwing.
 */
export const pathExists = async (path: string) => {
  if (isSshRemotePath(path)) {
    try {
      const { sshRemoteLocationExists } = await import('./ssh/ssh-remote-git')
      return await sshRemoteLocationExists(path)
    } catch {
      return false
    }
  }

  return access(path).then(constant(true), constant(false))
}
