# SSH remote repositories

Desktop Plus can open a Git repository that lives on another machine and run
the usual repository workflows over the system OpenSSH client (`ssh`).

The connection dialog has two modes.

**SSH config** lists `Host` aliases from `~/.ssh/config` and its `Include`
files. A pattern that is `*` or contains `*` or `?` is hidden. Choosing an
alias shows the `User`, `HostName`, `Port`, and `IdentityFile` that OpenSSH
would use (`ssh -G`). The repository stores that resolved user, host, port,
and key. A port or identity file that OpenSSH left at its default is not
written into the connection, so later `ssh` commands do not override your
config with those defaults.

**Manual** keeps the `user@host` form, plus an optional port and identity
file. You can also type only a Host alias. Leave port and identity file empty
to keep the values from your SSH config.

If the config cannot be read, or it has no usable hosts, the dialog opens in
Manual mode and says why. The `ssh` process itself still uses your agent,
keys, and `known_hosts` the same way a terminal session does.

Options that exist only on the alias, such as `ProxyJump`, are not copied
into the saved connection. Put those options on a `Host` pattern that matches
the resolved host name, or connect in Manual mode as `user@alias` and leave
port and identity file empty so OpenSSH keeps reading that alias.

## Try it

1. Start Desktop Plus.
2. File → Connect to SSH Host… (or the repository list + menu).
3. Choose a host from your SSH config, or enter `user@host` (or only a Host
   alias). Add a port or identity file only when you need them.
4. Connect. Confirm any host-key, passphrase, or password prompt.
5. Type an absolute remote path (or browse from the home directory) and add it.

The repository appears in the list with an SSH badge. Status, diff, commit,
checkout, creating a branch, push, and pull run `git` on that host.

In-progress merge, rebase, and cherry-pick state is read from the remote git
directory (`MERGE_HEAD`, `rebase-merge`, `CHERRY_PICK_HEAD`, and the sequencer
files). Status loads those markers in one SSH command. Syntax highlighting and
diff expansion read the start of a working-tree file with remote `dd` (at most
1 MiB). The conflict-resolution diff reads the remote working-tree file, and
the last-fetched time comes from the remote `FETCH_HEAD` timestamp. Discarding
an untracked file deletes it on the host; discarding a tracked change restores
it with `git checkout`.

Repository settings and the changes-list Ignore action read and write the
remote `.gitignore`. A symbolic link is refused, and the new contents are
written to a temporary file in the repository before replacing `.gitignore`,
so the write does not follow a link. Copilot conflict resolutions are written
the same way. Open in shell starts the selected terminal and runs the system
`ssh` client in that repository. The terminal session is a normal SSH login:
it is not given Desktop's askpass trampoline, and it does not turn off host-key
checking.

## Intentional gaps

- Push and pull authenticate with the **remote host's** Git and SSH
  credentials. Desktop's signed-in account and askpass trampoline are not
  forwarded to `git` on the remote.
- The remote login shell must be POSIX `sh`-compatible, and `git` must be on
  its `PATH`. A native Windows shell (`cmd.exe`) is not supported.
- There is no local filesystem watch. The repository refreshes when Desktop
  refreshes it. If the host is unreachable, the repository is shown as missing
  until Check again succeeds.
- Reveal in Finder/Explorer and the external editor stay disabled. Those
  actions expect a local working tree. Warp, Hyper, Tabby, Black Box, and
  COSMIC Terminal cannot be given an SSH command; choose another shell in
  Options.
- Linked worktrees are not managed.
- External diff tools and other features that open working-tree files outside
  the diff, gitignore, and conflict-resolution flows still use the local
  filesystem.
- Desktop hook UI is not used. Hooks configured in the remote repository run
  on the host.
- Git LFS progress and Desktop's credential helper are not forwarded.
- On Windows the OpenSSH client is invoked without connection multiplexing, so
  a key that is not loaded in `ssh-agent` may prompt on each Git command.
