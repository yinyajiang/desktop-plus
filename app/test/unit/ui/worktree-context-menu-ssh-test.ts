import assert from 'node:assert'
import { before, describe, it, mock } from 'node:test'
import { formatSshRemoteLocation } from '../../../src/lib/ssh/ssh-remote-location'

const location = formatSshRemoteLocation({
  user: 'dev',
  hostname: 'example.com',
  port: null,
  identityFile: null,
  remotePath: '/srv/repos/feature',
})

let copied: string | null = null
let generateWorktreeContextMenuItems: typeof import('../../../src/ui/worktrees/worktree-list-item-context-menu').generateWorktreeContextMenuItems

before(async () => {
  mock.module('../../../src/ui/main-process-proxy.ts', {
    namedExports: {
      writeClipboardText: (text: string) => {
        copied = text
      },
    },
  })
  ;({ generateWorktreeContextMenuItems } = await import(
    '../../../src/ui/worktrees/worktree-list-item-context-menu'
  ))
})

describe('SSH worktree context menu', () => {
  it('copies the remote POSIX path and offers delete for a linked worktree', () => {
    copied = null
    let removed: string | null = null
    const items = generateWorktreeContextMenuItems({
      path: location,
      isMainWorktree: false,
      isLocked: false,
      onRemoveWorktree: path => {
        removed = path
      },
      onCopyPath: path => {
        copied = path
      },
    })

    const copy = items.find(
      item =>
        'label' in item &&
        typeof item.label === 'string' &&
        /Copy [Ww]orktree [Pp]ath/.test(item.label)
    )
    assert.ok(copy && 'action' in copy && copy.action)
    copy.action!()
    assert.strictEqual(copied, '/srv/repos/feature')
    assert.doesNotMatch(copied!, /desktop-ssh/)

    const del = items.find(
      item =>
        'label' in item &&
        typeof item.label === 'string' &&
        item.label === 'Delete…'
    )
    assert.ok(del && 'enabled' in del && del.enabled === true)
    assert.ok(del && 'action' in del && del.action)
    del.action!()
    assert.strictEqual(removed, location)
  })

  it('disables delete for the main worktree', () => {
    const items = generateWorktreeContextMenuItems({
      path: location,
      isMainWorktree: true,
      isLocked: false,
      onRemoveWorktree: () => {},
    })
    const del = items.find(
      item =>
        'label' in item &&
        typeof item.label === 'string' &&
        item.label === 'Delete…'
    )
    assert.ok(del && 'enabled' in del && del.enabled === false)
  })
})
