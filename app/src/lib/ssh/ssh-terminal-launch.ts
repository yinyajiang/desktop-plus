import { ShellError } from '../shells/error'
import {
  ISshRemoteLocation,
  buildInteractiveSshArgs,
  quotePosixCommand,
} from './ssh-remote-location'

export interface ISshTerminalLaunch {
  readonly file: string
  readonly args: readonly string[]
  /** Windows console apps need a visible console. Terminal emulators do too. */
  readonly windowsHide: boolean
}

/**
 * Argv for a local terminal emulator that runs `ssh` in the remote repository.
 *
 * The `ssh` options come from {@link buildInteractiveSshArgs}. They do not
 * point at an SSH config file or disable host-key checking.
 */
export function planSshTerminalLaunch(input: {
  readonly platform: NodeJS.Platform
  readonly shell: string
  readonly terminalPath: string
  readonly sshPath: string
  readonly location: ISshRemoteLocation
}): ISshTerminalLaunch {
  const sshArgs = buildInteractiveSshArgs(input.location)
  const command = [input.sshPath, ...sshArgs]

  if (input.platform === 'darwin') {
    return planDarwin(input.shell, input.terminalPath, command)
  }
  if (input.platform === 'linux') {
    return planLinux(input.shell, input.terminalPath, command)
  }
  if (input.platform === 'win32') {
    return planWindows(input.shell, input.terminalPath, command)
  }

  throw unsupported(input.shell)
}

function planDarwin(
  shell: string,
  terminalPath: string,
  command: readonly string[]
): ISshTerminalLaunch {
  const script = quotePosixCommand(command)
  switch (shell) {
    case 'Terminal':
      return osascript(
        `tell application "Terminal" to do script ${appleScriptString(script)}`
      )
    case 'iTerm2':
      return osascript(
        [
          'tell application "iTerm"',
          'create window with default profile',
          `tell current session of current window to write text ${appleScriptString(
            script
          )}`,
          'end tell',
        ].join('\n')
      )
    case 'Kitty':
      return program(terminalPath, command)
    case 'Alacritty':
    case 'Ghostty':
      return program(terminalPath, ['-e', ...command])
    case 'WezTerm':
      return program(terminalPath, ['start', '--', ...command])
    default:
      throw unsupported(shell)
  }
}

function planLinux(
  shell: string,
  terminalPath: string,
  command: readonly string[]
): ISshTerminalLaunch {
  switch (shell) {
    case 'GNOME Terminal':
    case 'GNOME Console':
    case 'Ptyxis':
    case 'MATE Terminal':
      return program(terminalPath, ['--', ...command])
    case 'Kitty':
      return program(terminalPath, command)
    case 'Tilix':
    case 'URxvt':
    case 'Konsole':
    case 'XTerm':
    case 'Terminology':
    case 'Deepin Terminal':
    case 'Elementary Terminal':
    case 'Alacritty':
    case 'Ghostty':
      return program(terminalPath, ['-e', ...command])
    case 'Terminator':
    case 'XFCE Terminal':
      return program(terminalPath, ['-x', ...command])
    case 'LXDE Terminal':
      return program(terminalPath, ['-e', quotePosixCommand(command)])
    default:
      throw unsupported(shell)
  }
}

function planWindows(
  shell: string,
  terminalPath: string,
  command: readonly string[]
): ISshTerminalLaunch {
  const [sshPath, ...sshArgs] = command
  switch (shell) {
    case 'Windows Terminal':
      return program(terminalPath, ['-w', '0', 'new-tab', '--', ...command])
    case 'Alacritty':
      return program(terminalPath, ['-e', ...command])
    case 'Git Bash':
      return program(terminalPath, ['-c', quotePosixCommand(command)])
    case 'Cygwin':
      return program(terminalPath, ['-e', ...command])
    default:
      // ssh.exe is a console program. A GUI parent gets a new console window,
      // so Command Prompt and PowerShell do not have to re-quote the command.
      return program(sshPath, sshArgs)
  }
}

function program(file: string, args: readonly string[]): ISshTerminalLaunch {
  return { file, args, windowsHide: false }
}

function osascript(source: string): ISshTerminalLaunch {
  return { file: 'osascript', args: ['-e', source], windowsHide: false }
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function unsupported(shell: string): ShellError {
  return new ShellError(
    `Open in ${shell} cannot start an SSH session. In Options, choose Terminal, iTerm, GNOME Terminal, Kitty, Alacritty, Konsole, xterm, or Windows Terminal.`
  )
}
