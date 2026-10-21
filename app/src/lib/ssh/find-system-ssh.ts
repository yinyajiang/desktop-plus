import { existsSync } from 'fs'

let systemSshPath: string | null = null

/**
 * The OpenSSH client used for remote repositories.
 *
 * Windows prefers the system OpenSSH so `ssh -G` and later connections read
 * the same config. Other platforms use `ssh` on `PATH`.
 */
export function findSystemSsh(): string {
  if (systemSshPath) {
    return systemSshPath
  }

  if (process.platform === 'win32') {
    const windowsOpenSSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    if (existsSync(windowsOpenSSH)) {
      systemSshPath = windowsOpenSSH
      return systemSshPath
    }
  }

  systemSshPath = 'ssh'
  return systemSshPath
}
