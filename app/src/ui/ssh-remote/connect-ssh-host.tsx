import * as React from 'react'
import { posix } from 'path'
import untildify from 'untildify'

import { Dispatcher } from '../dispatcher'
import { Button } from '../lib/button'
import { TextBox } from '../lib/text-box'
import { Row } from '../lib/row'
import { Select } from '../lib/select'
import { RadioGroup } from '../lib/radio-group'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { FoldoutType } from '../../lib/app-state'
import {
  ISshRemoteLocation,
  formatSshRemoteLocation,
  isValidPort,
  parseSshManualConnectionInput,
} from '../../lib/ssh/ssh-remote-location'
import {
  ISshConfigHostEndpoint,
  listSshConfigHostAliases,
  resolveManualSshConnection,
  resolveSshConfigHost,
} from '../../lib/ssh/ssh-config-hosts'
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

type SshConnectMode = 'config' | 'manual'

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
  readonly mode: SshConnectMode
  readonly modeChosen: boolean
  readonly hostAliases: ReadonlyArray<string>
  readonly hostFilter: string
  readonly selectedAlias: string
  readonly preview: ISshConfigHostEndpoint | null
  readonly resolvingAlias: boolean
  readonly loadingHosts: boolean
  readonly configHint: string | null
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
 * Add an SSH host, then add a Git repository that lives on that host.
 *
 * SSH config mode lists Host aliases from ~/.ssh/config. Manual mode still
 * accepts user@host, and also a Host alias with optional fields left blank.
 */
export class ConnectSSHHost extends React.Component<
  IConnectSSHHostProps,
  IConnectSSHHostState
> {
  private alive = true
  private aliasRequest = 0

  public constructor(props: IConnectSSHHostProps) {
    super(props)

    this.state = {
      mode: 'config',
      modeChosen: false,
      hostAliases: [],
      hostFilter: '',
      selectedAlias: '',
      preview: null,
      resolvingAlias: false,
      loadingHosts: true,
      configHint: null,
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

  public componentDidMount() {
    this.loadHosts()
  }

  public componentWillUnmount() {
    this.alive = false
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
          {this.renderModeSwitch()}
          {this.state.configHint ? (
            <p className="ssh-remote-note">{this.state.configHint}</p>
          ) : null}
          {this.state.mode === 'config'
            ? this.renderConfigMode()
            : this.renderManualMode()}
          {connected ? this.renderRemotePath() : null}
        </DialogContent>

        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={connected ? 'Add repository' : 'Connect'}
            okButtonDisabled={this.isSubmitDisabled(connected)}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private isSubmitDisabled(connected: boolean): boolean {
    if (this.state.busy) {
      return true
    }
    if (connected) {
      return this.state.remotePath.trim().length === 0
    }
    if (this.state.mode === 'config') {
      return this.state.preview === null || this.state.resolvingAlias
    }
    return false
  }

  private renderModeSwitch() {
    return (
      <Row className="ssh-connect-mode-row">
        <span id="ssh-connect-mode-label">Connect with</span>
        <RadioGroup<SshConnectMode>
          ariaLabelledBy="ssh-connect-mode-label"
          className="ssh-connect-mode"
          selectedKey={this.state.mode}
          radioButtonKeys={['config', 'manual']}
          onSelectionChanged={this.onModeChanged}
          renderRadioButtonLabelContents={this.renderModeLabel}
        />
      </Row>
    )
  }

  private renderModeLabel = (mode: SshConnectMode) => {
    return mode === 'config' ? 'SSH config' : 'Manual'
  }

  private renderConfigMode() {
    const filtered = this.filteredAliases()
    const selectionInList = filtered.includes(this.state.selectedAlias)

    return (
      <>
        <p className="ssh-remote-note">
          Choose a host from your SSH config. The repository saves the resolved
          user, host, port, and key. Port and identity file are left unset when
          your config did not set them.
        </p>
        <Row>
          <TextBox
            label="Filter hosts"
            placeholder="Search host aliases"
            value={this.state.hostFilter}
            autoFocus={true}
            onValueChanged={this.onHostFilterChanged}
          />
        </Row>
        <div className="select-component ssh-config-hosts">
          <label htmlFor="ssh-config-host-list">Host</label>
          <select
            id="ssh-config-host-list"
            size={8}
            value={selectionInList ? this.state.selectedAlias : ''}
            onChange={this.onAliasSelected}
          >
            <option value="">
              {filtered.length === 0
                ? this.state.loadingHosts
                  ? 'Reading SSH config…'
                  : 'No matching hosts'
                : 'Choose a host'}
            </option>
            {filtered.map(alias => (
              <option key={alias} value={alias}>
                {alias}
              </option>
            ))}
          </select>
        </div>
        {this.renderPreview()}
      </>
    )
  }

  private renderPreview() {
    if (this.state.resolvingAlias) {
      return <p className="ssh-remote-note">Reading host settings…</p>
    }

    const preview = this.state.preview
    if (preview === null || preview.alias !== this.state.selectedAlias) {
      return null
    }

    const identity =
      preview.identityFiles.length === 0
        ? 'Default'
        : preview.identityFiles.join(', ')

    return (
      <>
        <div className="ssh-config-preview">
          <div>
            <span className="ssh-config-preview-label">User</span>
            <span>{preview.user}</span>
          </div>
          <div>
            <span className="ssh-config-preview-label">HostName</span>
            <span>{preview.hostname}</span>
          </div>
          <div>
            <span className="ssh-config-preview-label">Port</span>
            <span>
              {preview.port === null ? 'Default' : String(preview.port)}
            </span>
          </div>
          <div>
            <span className="ssh-config-preview-label">IdentityFile</span>
            <span>{identity}</span>
          </div>
        </div>
        {preview.identityFiles.length > 1 ? (
          <p className="ssh-remote-note">
            The saved connection uses the first identity file.
          </p>
        ) : null}
        {preview.source === 'config-file' ? (
          <p className="ssh-remote-note">
            These values were not confirmed with ssh -G.
          </p>
        ) : null}
      </>
    )
  }

  private renderManualMode() {
    return (
      <>
        <p className="ssh-remote-note">
          Enter user@host, or only a Host alias. Leave port and identity file
          empty to keep the values from your SSH config. The system ssh command
          still uses your agent, keys, and known_hosts.
        </p>
        {this.renderRecentHosts()}
        <Row>
          <TextBox
            label="Connection"
            placeholder="user@host or host alias"
            value={this.state.connection}
            autoFocus={!this.state.loadingHosts}
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
      </>
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

  private filteredAliases(): readonly string[] {
    const filter = this.state.hostFilter.trim().toLowerCase()
    if (filter.length === 0) {
      return this.state.hostAliases
    }
    return this.state.hostAliases.filter(alias =>
      alias.toLowerCase().includes(filter)
    )
  }

  private loadHosts = async () => {
    let listed: { aliases: ReadonlyArray<string>; hint: string | null }
    try {
      listed = await listSshConfigHostAliases()
    } catch {
      listed = {
        aliases: [],
        hint: "Couldn't read ~/.ssh/config. Enter the connection manually.",
      }
    }

    if (!this.alive) {
      return
    }

    this.setState(state => {
      const noHosts = listed.aliases.length === 0
      const mode = state.modeChosen ? state.mode : noHosts ? 'manual' : 'config'
      return {
        hostAliases: listed.aliases,
        configHint: listed.hint,
        loadingHosts: false,
        mode,
      }
    })
  }

  private onModeChanged = (mode: SshConnectMode) => {
    this.aliasRequest++
    this.setState({
      mode,
      modeChosen: true,
      resolvingAlias: false,
      connectedLocation: null,
      directories: [],
      error: null,
    })
  }

  private onHostFilterChanged = (hostFilter: string) => {
    this.setState({ hostFilter })
  }

  private onAliasSelected = (event: React.FormEvent<HTMLSelectElement>) => {
    const alias = event.currentTarget.value
    if (alias.length === 0) {
      this.aliasRequest++
      this.setState({
        selectedAlias: '',
        preview: null,
        resolvingAlias: false,
        connectedLocation: null,
        directories: [],
        error: null,
      })
      return
    }

    if (alias === this.state.selectedAlias && this.state.preview) {
      return
    }

    const request = ++this.aliasRequest
    this.setState({
      selectedAlias: alias,
      preview: null,
      resolvingAlias: true,
      connectedLocation: null,
      directories: [],
      error: null,
    })
    this.resolveAlias(alias, request)
  }

  private resolveAlias = async (alias: string, request: number) => {
    try {
      const preview = await resolveSshConfigHost(alias)
      if (!this.alive || request !== this.aliasRequest) {
        return
      }
      if (preview === null) {
        this.setState({
          resolvingAlias: false,
          preview: null,
          error: `Couldn't read SSH settings for ${alias}.`,
        })
        return
      }
      this.setState({ preview, resolvingAlias: false, error: null })
    } catch (error) {
      if (!this.alive || request !== this.aliasRequest) {
        return
      }
      this.setState({
        resolvingAlias: false,
        preview: null,
        error: errorMessage(error),
      })
    }
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
    if (this.state.busy || this.state.resolvingAlias) {
      return
    }

    if (this.state.connectedLocation === null) {
      this.connect()
    } else {
      this.addRepository()
    }
  }

  private connect = async () => {
    const location = await this.readLocation()
    if (location === null) {
      return
    }

    this.setState({ busy: true, error: null })
    try {
      await testSshConnection(location)
      const home = await expandRemotePath(location, '~')
      const recentHosts = rememberSshHost(recentHostFromLocation(location))
      const recentKey = sshRecentHostKey(recentHostFromLocation(location))
      this.setState(state => ({
        connectedLocation: location,
        remotePath: home,
        recentHosts,
        selectedRecent: recentKey,
        // A config-mode connection is stored as concrete user@host fields.
        // Mirror them into the manual form so switching modes shows the same
        // connection the repository will keep. Manual mode keeps the text the
        // user already typed. These are always strings so setState matches
        // IConnectSSHHostState; unset OpenSSH defaults stay null on `location`.
        connection:
          state.mode === 'config'
            ? `${location.user}@${location.hostname}`
            : state.connection,
        port:
          state.mode === 'config'
            ? location.port === null
              ? ''
              : String(location.port)
            : state.port,
        identityFile:
          state.mode === 'config'
            ? location.identityFile ?? ''
            : state.identityFile,
      }))
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
   * Build a location from the form. `remotePath` is filled in after connect.
   * The value persisted later is this same concrete connection.
   */
  private readLocation = async (): Promise<ISshRemoteLocation | null> => {
    if (this.state.mode === 'config') {
      return this.readConfigLocation()
    }
    return this.readManualLocation()
  }

  private readConfigLocation(): ISshRemoteLocation | null {
    const preview = this.state.preview
    if (
      preview === null ||
      preview.alias !== this.state.selectedAlias ||
      this.state.resolvingAlias
    ) {
      this.setState({ error: 'Choose a host from your SSH config.' })
      return null
    }

    return {
      user: preview.user,
      hostname: preview.hostname,
      port: preview.port,
      identityFile: preview.identityFile,
      remotePath: '/',
    }
  }

  private readManualLocation = async (): Promise<ISshRemoteLocation | null> => {
    const parsed = parseSshManualConnectionInput(this.state.connection)
    if (parsed === null) {
      this.setState({
        error:
          'Enter a connection like user@host, or a Host alias. An optional :port is allowed on user@host.',
      })
      return null
    }

    const portText = this.state.port.trim()
    let portOverride: number | null = null
    if (portText.length > 0) {
      const parsedPort = Number(portText)
      if (!isValidPort(parsedPort)) {
        this.setState({ error: 'Port must be a number from 1 to 65535.' })
        return null
      }
      portOverride = parsedPort
    }

    const identityText = this.state.identityFile.trim()
    const fields = await resolveManualSshConnection(parsed, {
      port: portOverride,
      identityFile: identityText.length > 0 ? untildify(identityText) : null,
    })
    if (fields === null) {
      const alias =
        parsed.kind === 'alias' ? parsed.alias : this.state.connection
      this.setState({ error: `Couldn't resolve SSH host ${alias}.` })
      return null
    }

    return { ...fields, remotePath: '/' }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  return 'The SSH operation failed.'
}
