# SSH remote repositories

Desktop Plus can open a Git repository that lives on another machine and run
the usual repository workflows over the system OpenSSH client (`ssh`).

The connection form asks you to type `user@host`, an optional port, and an
optional identity-file path. It does not read `~/.ssh/config` to offer a list
of hosts. The `ssh` process itself still uses your agent, keys, and
`known_hosts` the same way a terminal session does.

## Try it

1. Start Desktop Plus.
2. File → Connect to SSH Host… (or the repository list + menu).
3. Enter `user@host`. Add a port or identity file only when you need them.
4. Connect. Confirm any host-key, passphrase, or password prompt.
5. Type an absolute remote path (or browse from the home directory) and add it.

The repository appears in the list with an SSH badge. Status, diff, commit,
checkout, creating a branch, push, and pull run `git` on that host.

## Intentional gaps

- Push and pull authenticate with the **remote host's** Git and SSH
  credentials. Desktop's signed-in account and askpass trampoline are not
  forwarded to `git` on the remote.
- The remote login shell must be POSIX `sh`-compatible, and `git` must be on
  its `PATH`. A native Windows shell (`cmd.exe`) is not supported.
- There is no local filesystem watch. The repository refreshes when Desktop
  refreshes it. If the host is unreachable, the repository is shown as missing
  until Check again succeeds.
- Open in shell, Reveal in Finder/Explorer, and the external editor stay
  disabled. Those actions expect a local working tree.
- Linked worktrees are not managed.
- In-progress merge, rebase, and cherry-pick detection reads files under the
  local `.git` directory, so those conflict flows are incomplete for SSH
  repositories.
- Desktop hook UI is not used. Hooks configured in the remote repository run
  on the host.
- Git LFS progress and Desktop's credential helper are not forwarded.
- On Windows the OpenSSH client is invoked without connection multiplexing, so
  a key that is not loaded in `ssh-agent` may prompt on each Git command.
- Image diffs of the working tree are read with remote `cat`. Other features
  that open working-tree files locally (for example external diff tools) do
  not see the remote files.
