import * as Path from 'path'
import { CopyPathNormalization } from '../../models/copy-path-normalization'
import { Repository } from '../../models/repository'

export function normalizePath(path: string): string {
  // Git expects forward slashes, even on Windows.
  // Also trim trailing slashes
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function convertToCopyPath(
  path: string,
  normalization: CopyPathNormalization
): string {
  switch (normalization) {
    case CopyPathNormalization.Unix:
      return path.replace(/\\/g, '/')
    case CopyPathNormalization.Windows:
      return path.replace(/\//g, '\\')
    case CopyPathNormalization.None:
      return path
  }
}

/**
 * Clipboard text for a repository file or folder path.
 *
 * "full" is the absolute local path for ordinary repositories. SSH checkouts
 * have no local absolute path, so full and relative both return the
 * repository-relative path without a `desktop-ssh:` prefix. Relative and SSH
 * paths always use forward slashes (e.g. `apps/web-base/nuxt.config.ts`).
 */
export function getRepositoryClipboardPath(
  repository: Repository,
  relativePath: string,
  kind: 'full' | 'relative' = 'full'
): string {
  if (kind === 'relative' || repository.sshRemote !== null) {
    return normalizePath(relativePath)
  }
  return Path.join(repository.path, relativePath)
}
