import { spawn } from 'child_process'
import { findSystemSsh } from './ssh-remote-git'
import { ISshRemoteLocation } from './ssh-remote-location'
import { planSshTerminalLaunch } from './ssh-terminal-launch'

/** Open the user's terminal and run `ssh` in the remote repository. */
export function launchSshRemoteShell(
  shellName: string,
  terminalPath: string,
  location: ISshRemoteLocation,
  onError: (error: Error) => void
): void {
  const plan = planSshTerminalLaunch({
    platform: process.platform,
    shell: shellName,
    terminalPath,
    sshPath: findSystemSsh(),
    location,
  })
  const child = spawn(plan.file, [...plan.args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: plan.windowsHide,
  })
  child.on('error', error => {
    log.debug(`Failed to open an SSH session in ${shellName}`, error)
    onError(error)
  })
  child.unref()
}
