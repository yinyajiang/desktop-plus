import * as React from 'react'
import { posix } from 'path'
import untildify from 'untildify'

import { Dispatcher } from '../dispatcher'
import { Button } from '../lib/button'
import { TextBox } from '../lib/text-box'
import { Row } from '../lib/row'
import { Select } from '../lib/select'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { FoldoutType } from '../../lib/app-state'
import {
  ISshRemoteLocation,
  formatSshRemoteLocation,
  isValidPort,
  parseSshConnectionInput,
} from '../../lib/ssh/ssh-remote-location'
import {
  ISshRecentHost,
  formatSshRecentHost,
  getRecentSshHosts,
  recentHostFromLocation,
  rememberSshHost,
  sshRecentHostKey,
} from '../../lib/ssh/ssh-remote-hosts'
import {
  expandRemotePath,
  listRemoteDirectories,
  probeSshRepository,
  testSshConnection,
} from '../../lib/ssh/ssh-remote-git'

class RemoteDirectoryButton extends React.Component<{
  readonly name: string
  readonly onOpen: (name: string) => void
}> {
  private onClick = () => {
    this.props.onOpen(this.props.name)
  }

  public render() {
    return <Button onClick={this.onClick}>{this.props.name}/</Button>
  }
}

interface IConnectSSHHostProps {
  readonly dispatcher: Dispatcher
  readonly onDismissed: () => void
}

interface IConnectSSHHostState {
  readonly connection: string
  readonly port: string
  readonly identityFile: string
  readonly remotePath: string
  readonly connectedLocation: ISshRemoteLocation | null
  readonly directories: ReadonlyArray<string>
  readonly recentHosts: ReadonlyArray<ISshRecentHost>
  readonly selectedRecent: string
  readonly error: string | null
  readonly busy: boolean
}

/**
 * Add an SSH host by typing the connection, then add a Git repository that
 * lives on that host. Hosts are not loaded from ~/.ssh/config.
 */
export class ConnectSSHHost extends React.Component<
  IConnectSSHHostProps,
  IConnectSSHHostState
> {
  public constructor(props: IConnectSSHHostProps) {
    super(props)

    this.state = {
      connection: '',
      port: '',
      identityFile: '',
      remotePath: '',
      connectedLocation: null,
      directories: [],
      recentHosts: getRecentSshHosts(),
      selectedRecent: '',
      error: null,
      busy: false,
    }
  }

  public render() {
    const connected = this.state.connectedLocation !== null

    return (
      <Dialog
        id="connect-ssh-host"
        title={__DARWIN__ ? 'Connect to SSH Host' : 'Connect to SSH host'}
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={this.state.busy}
        disabled={this.state.busy}
      >
        {this.state.error ? (
          <DialogError>{this.state.error}</DialogError>
        ) : null}

        <DialogContent>
          <p className="ssh-remote-note">
            Type the connection yourself, for example ada@dev.example.com.
            Desktop Plus does not load hosts from your SSH config. The system
            ssh command still uses your agent, keys, and known_hosts.
          </p>

          {this.renderRecentHosts()}

          <Row>
            <TextBox
              label="Connection"
              placeholder="user@host"
              value={this.state.connection}
              autoFocus={true}
              onValueChanged={this.onConnectionChanged}
            />
          </Row>
          <Row>
            <TextBox
              label="Port"
              placeholder="22"
              value={this.state.port}
              onValueChanged={this.onPortChanged}
            />
          </Row>
          <Row>
            <TextBox
              label="Identity file"
              placeholder="Optional path to a private key"
              value={this.state.identityFile}
              onValueChanged={this.onIdentityFileChanged}
            />
          </Row>

          {connected ? this.renderRemotePath() : null}
        </DialogContent>

        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={connected ? 'Add repository' : 'Connect'}
            okButtonDisabled={
              this.state.busy ||
              (connected && this.state.remotePath.trim().length === 0)
            }
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private renderRecentHosts() {
    if (this.state.recentHosts.length === 0) {
      return null
    }

    return (
      <Row>
        <Select
          label="Recent hosts"
          value={this.state.selectedRecent}
          onChange={this.onRecentHostChanged}
        >
          <option value="">Enter a new host</option>
          {this.state.recentHosts.map(host => (
            <option key={sshRecentHostKey(host)} value={sshRecentHostKey(host)}>
              {formatSshRecentHost(host)}
            </option>
          ))}
        </Select>
      </Row>
    )
  }

  private renderRemotePath() {
    return (
      <>
        <p className="ssh-remote-note">
          Enter the remote working tree, or open a directory below. Status,
          commit, branch, push, and pull run on this host. Push and pull use the
          host's own Git credentials.
        </p>
        <Row>
          <TextBox
            label="Remote path"
            placeholder="/home/user/src/project"
            value={this.state.remotePath}
            onValueChanged={this.onRemotePathChanged}
          />
          <Button onClick={this.onListDirectory}>List</Button>
        </Row>
        {this.state.directories.length > 0 ? (
          <div className="ssh-remote-browser">
            <Button onClick={this.onBrowseUp}>Up</Button>
            <ul>
              {this.state.directories.map(name => (
                <li key={name}>
                  <RemoteDirectoryButton
                    name={name}
                    onOpen={this.onOpenDirectory}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </>
    )
  }

  private onConnectionChanged = (connection: string) => {
    this.setState({
      connection,
      connectedLocation: null,
      directories: [],
      error: null,
      selectedRecent: '',
    })
  }

  private onPortChanged = (port: string) => {
    this.setState({
      port,
      connectedLocation: null,
      directories: [],
      error: null,
    })
  }

  private onIdentityFileChanged = (identityFile: string) => {
    this.setState({
      identityFile,
      connectedLocation: null,
      directories: [],
      error: null,
    })
  }

  private onRemotePathChanged = (remotePath: string) => {
    this.setState({ remotePath, error: null })
  }

  private onRecentHostChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const key = event.currentTarget.value
    const host = this.state.recentHosts.find(
      candidate => sshRecentHostKey(candidate) === key
    )
    if (!host) {
      this.setState({ selectedRecent: '' })
      return
    }

    this.setState({
      selectedRecent: key,
      connection: `${host.user}@${host.hostname}`,
      port: host.port === null ? '' : String(host.port),
      identityFile: host.identityFile ?? '',
      connectedLocation: null,
      directories: [],
      error: null,
    })
  }

  private onSubmit = () => {
    if (this.state.busy) {
      return
    }

    if (this.state.connectedLocation === null) {
      this.connect()
    } else {
      this.addRepository()
    }
  }

  private connect = async () => {
    const location = this.readLocation(null)
    if (location === null) {
      return
    }

    this.setState({ busy: true, error: null })
    try {
      await testSshConnection(location)
      const home = await expandRemotePath(location, '~')
      const recentHosts = rememberSshHost(recentHostFromLocation(location))
      this.setState({
        connectedLocation: location,
        remotePath: home,
        recentHosts,
        selectedRecent: sshRecentHostKey(recentHostFromLocation(location)),
      })
      await this.listDirectory(location, home)
    } catch (error) {
      this.setState({ error: errorMessage(error) })
    } finally {
      this.setState({ busy: false })
    }
  }

  private onListDirectory = () => {
    const location = this.state.connectedLocation
    if (!location) {
      return
    }

    this.listDirectory(location, this.state.remotePath)
  }

  private onBrowseUp = () => {
    const location = this.state.connectedLocation
    if (!location) {
      return
    }

    const parent = posix.dirname(this.state.remotePath)
    this.setState({ remotePath: parent })
    this.listDirectory(location, parent)
  }

  private onOpenDirectory = (name: string) => {
    const location = this.state.connectedLocation
    if (!location) {
      return
    }

    const next = posix.join(this.state.remotePath, name)
    this.setState({ remotePath: next })
    this.listDirectory(location, next)
  }

  private listDirectory = async (
    location: ISshRemoteLocation,
    directory: string
  ) => {
    this.setState({ busy: true, error: null, remotePath: directory })
    try {
      const directories = await listRemoteDirectories(location, directory)
      this.setState(state =>
        state.remotePath === directory ? { directories } : null
      )
    } catch (error) {
      this.setState(state =>
        state.remotePath === directory
          ? { error: errorMessage(error), directories: [] }
          : null
      )
    } finally {
      this.setState({ busy: false })
    }
  }

  private addRepository = async () => {
    const base = this.state.connectedLocation
    if (!base) {
      return
    }

    this.setState({ busy: true, error: null })
    try {
      const remotePath = await expandRemotePath(base, this.state.remotePath)
      const location = { ...base, remotePath }
      const probe = await probeSshRepository(formatSshRemoteLocation(location))

      if (probe.kind === 'bare') {
        this.setState({
          error:
            'This directory appears to be a bare repository. Bare repositories are not currently supported.',
        })
        return
      }

      if (probe.kind === 'unsafe') {
        this.setState({
          error: `Git on the remote host rejected this repository (dubious ownership). On the remote host, run: git config --global --add safe.directory ${probe.path}`,
        })
        return
      }

      if (probe.kind === 'missing') {
        this.setState({ error: probe.message })
        return
      }

      const repositories = await this.props.dispatcher.addRepositories(
        [probe.topLevelWorkingDirectory],
        null
      )

      if (repositories.length === 0) {
        this.setState({ error: 'Unable to add the remote repository.' })
        return
      }

      this.props.onDismissed()
      this.props.dispatcher.closeFoldout(FoldoutType.Repository)
      this.props.dispatcher.selectRepository(repositories[0])
      this.props.dispatcher.recordAddExistingRepository()
    } catch (error) {
      this.setState({ error: errorMessage(error) })
    } finally {
      this.setState({ busy: false })
    }
  }

  /**
   * Build a location from the form. `remotePath` is filled in after connect;
   * pass null while connecting and the placeholder is replaced later.
   */
  private readLocation(remotePath: string | null): ISshRemoteLocation | null {
    const parsed = parseSshConnectionInput(this.state.connection)
    if (parsed === null) {
      this.setState({
        error:
          'Enter a connection like user@host. An optional :port is allowed.',
      })
      return null
    }

    let port = parsed.port
    const portText = this.state.port.trim()
    if (portText.length > 0) {
      const parsedPort = Number(portText)
      if (!isValidPort(parsedPort)) {
        this.setState({ error: 'Port must be a number from 1 to 65535.' })
        return null
      }
      port = parsedPort
    }

    const identityText = this.state.identityFile.trim()
    return {
      user: parsed.user,
      hostname: parsed.hostname,
      port,
      identityFile: identityText.length > 0 ? untildify(identityText) : null,
      remotePath: remotePath ?? '/',
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  return 'The SSH operation failed.'
}
