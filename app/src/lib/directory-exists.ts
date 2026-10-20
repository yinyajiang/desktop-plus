import { stat } from 'fs/promises'
import { isSshRemotePath } from './ssh/ssh-remote-location'

/**
 * Helper method to stat a path and check both that it exists and that it's
 * a directory.
 */
export const directoryExists = async (path: string) => {
  if (isSshRemotePath(path)) {
    try {
      const { sshRemoteDirectoryExists } = await import('./ssh/ssh-remote-git')
      return await sshRemoteDirectoryExists(path)
    } catch {
      return false
    }
  }

  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}
