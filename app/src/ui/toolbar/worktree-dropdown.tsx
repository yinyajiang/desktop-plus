import * as React from 'react'
import { Dispatcher } from '../dispatcher'
import * as octicons from '../octicons/octicons.generated'
import { Repository } from '../../models/repository'
import { ToolbarDropdown, DropdownState } from './dropdown'
import { FoldoutType, IConstrainedValue } from '../../lib/app-state'
import { getWorktreeDisplayName, WorktreeEntry } from '../../models/worktree'
import { WorktreeList } from '../worktrees/worktree-list'
import { showContextualMenu, IMenuItem } from '../../lib/menu-item'
import { generateWorktreeContextMenuItems } from '../worktrees/worktree-list-item-context-menu'
import { openRepositoryInNewWindow } from '../main-process-proxy'
import { PopupType } from '../../models/popup'
import { Resizable } from '../resizable'
import { enableResizingToolbarButtons } from '../../lib/feature-flag'

interface IWorktreeDropdownProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly worktrees: ReadonlyArray<WorktreeEntry>
  readonly isOpen: boolean
  readonly onDropDownStateChanged: (state: DropdownState) => void
  readonly enableFocusTrap: boolean
  readonly worktreeDropdownWidth: IConstrainedValue
  readonly disabled?: boolean
}

interface IWorktreeDropdownState {
  readonly filterText: string
}

export class WorktreeDropdown extends React.Component<
  IWorktreeDropdownProps,
  IWorktreeDropdownState
> {
  public constructor(props: IWorktreeDropdownProps) {
    super(props)
    this.state = {
      filterText: '',
    }
  }

  private onWorktreeClick = async (worktree: WorktreeEntry) => {
    if (this.props.disabled) {
      return
    }
    const { dispatcher, repository } = this.props

    dispatcher.closeFoldout(FoldoutType.Worktree)

    if (worktree.isPrunable) {
      // A missing SSH worktree stays listed until the host prunes it.
      // Desktop does not run `git worktree remove` or `prune` there.
      if (repository.sshRemote === null) {
        dispatcher.requestDeleteWorktree(repository, worktree.path)
      }
      return
    }

    await dispatcher.switchWorktree(repository, worktree)
  }

  private onWorktreeContextMenu = (
    worktree: WorktreeEntry,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault()

    const ssh = this.props.repository.sshRemote !== null
    const items = generateWorktreeContextMenuItems({
      path: worktree.path,
      isMainWorktree: worktree.type === 'main',
      isLocked: worktree.isLocked,
      onRenameWorktree: ssh ? undefined : this.onRenameWorktree,
      onRemoveWorktree: ssh ? undefined : this.onRemoveWorktree,
      onOpenInNewWindow: ssh
        ? undefined
        : () => this.onOpenWorktreeInNewWindow(worktree.path),
    })

    showContextualMenu(items)
  }

  private onOpenWorktreeInNewWindow = (worktreePath: string) => {
    this.props.dispatcher.closeFoldout(FoldoutType.Worktree)
    openRepositoryInNewWindow(worktreePath)
  }

  private onRenameWorktree = (path: string) => {
    this.props.dispatcher.closeFoldout(FoldoutType.Worktree)
    this.props.dispatcher.showPopup({
      type: PopupType.RenameWorktree,
      repository: this.props.repository,
      worktreePath: path,
    })
  }

  private onRemoveWorktree = (path: string) => {
    this.props.dispatcher.closeFoldout(FoldoutType.Worktree)
    this.props.dispatcher.requestDeleteWorktree(this.props.repository, path)
  }

  private onCreateNewWorktree = () => {
    this.props.dispatcher.closeFoldout(FoldoutType.Worktree)
    this.props.dispatcher.showPopup({
      type: PopupType.AddWorktree,
      repository: this.props.repository,
    })
  }

  private onContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (this.props.disabled) {
      return
    }

    const currentWorktree = this.getCurrentWorktree()
    if (currentWorktree === null) {
      return
    }

    const isMain = currentWorktree.type === 'main'
    const ssh = this.props.repository.sshRemote !== null

    const items = generateWorktreeContextMenuItems({
      path: currentWorktree.path,
      isMainWorktree: isMain,
      isLocked: currentWorktree.isLocked,
      onRemoveWorktree: isMain || ssh ? undefined : this.onRemoveWorktree,
    })

    if (ssh) {
      showContextualMenu(items)
      return
    }

    const newWorktreeItem: IMenuItem = {
      label: __DARWIN__ ? 'New Worktree…' : 'New worktree…',
      action: this.onCreateNewWorktree,
    }

    showContextualMenu([newWorktreeItem, { type: 'separator' }, ...items])
  }

  private onFilterTextChanged = (text: string) => {
    this.setState({ filterText: text })
  }

  private renderWorktreeFoldout = (): JSX.Element | null => {
    if (this.props.disabled) {
      return null
    }
    const { worktrees } = this.props

    return (
      <WorktreeList
        worktrees={worktrees}
        currentWorktree={this.getCurrentWorktree()}
        onWorktreeClick={this.onWorktreeClick}
        filterText={this.state.filterText}
        onFilterTextChanged={this.onFilterTextChanged}
        canCreateNewWorktree={this.props.repository.sshRemote === null}
        onCreateNewWorktree={this.onCreateNewWorktree}
        onWorktreeContextMenu={this.onWorktreeContextMenu}
      />
    )
  }

  private getCurrentWorktree(): WorktreeEntry | null {
    const repoPath = this.props.repository.path
    return this.props.worktrees.find(wt => wt.path === repoPath) ?? null
  }

  private onResize = (width: number) => {
    this.props.dispatcher.setWorktreeDropdownWidth(width)
  }

  private onReset = () => {
    this.props.dispatcher.resetWorktreeDropdownWidth()
  }

  public render() {
    const { isOpen, enableFocusTrap } = this.props
    const currentState: DropdownState = isOpen ? 'open' : 'closed'
    const currentWorktree = this.getCurrentWorktree()
    const title = currentWorktree
      ? getWorktreeDisplayName(currentWorktree)
      : this.props.repository.name
    const description = __DARWIN__ ? 'Current Worktree' : 'Current worktree'

    const toolbarDropdown = (
      <ToolbarDropdown
        className="worktree-button"
        icon={octicons.fileDirectory}
        title={title}
        description={description}
        tooltip={isOpen ? undefined : `Current worktree is ${title}`}
        onDropdownStateChanged={this.props.onDropDownStateChanged}
        onContextMenu={this.onContextMenu}
        dropdownContentRenderer={this.renderWorktreeFoldout}
        dropdownState={currentState}
        disabled={this.props.disabled}
        showDisclosureArrow={true}
        enableFocusTrap={enableFocusTrap}
        foldoutStyleOverrides={
          enableResizingToolbarButtons()
            ? {
                width: this.props.worktreeDropdownWidth.value,
                maxWidth: this.props.worktreeDropdownWidth.max,
                minWidth: 365,
              }
            : undefined
        }
      />
    )

    if (!enableResizingToolbarButtons()) {
      return toolbarDropdown
    }

    return (
      <Resizable
        width={this.props.worktreeDropdownWidth.value}
        onReset={this.onReset}
        onResize={this.onResize}
        maximumWidth={this.props.worktreeDropdownWidth.max}
        minimumWidth={this.props.worktreeDropdownWidth.min}
        description="Current worktree dropdown button"
      >
        {toolbarDropdown}
      </Resizable>
    )
  }
}
