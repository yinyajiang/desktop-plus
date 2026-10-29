Desktop Plus v3.6.9-beta1

Upstream:
- [GitHub Desktop 3.6.8-beta3 release notes](https://github.com/desktop/desktop/releases/tag/release-3.6.8-beta3)
- [GitHub Desktop 3.6.8-beta4 release notes](https://github.com/desktop/desktop/releases/tag/release-3.6.8-beta4)
- [GitHub Desktop 3.6.8 release notes](https://github.com/desktop/desktop/releases/tag/release-3.6.8)
- GitHub Desktop 3.6.9-beta1 fixes a crash when Copilot stops unexpectedly.

## Changes and improvements:

- Connect to an SSH host and add a Git repository that lives on that machine. Desktop lists Host aliases from `~/.ssh/config` and its `Include` files. Pick an alias, or type the destination yourself (`user@host`, or only a Host alias). Add a port or identity file only when you need them. The saved connection stores the resolved user, host, port, and key. The system OpenSSH client still uses your keys, agent, and `known_hosts`.

- The repository list marks the repository with an SSH badge. Status, diff, commit, checkout, creating a branch, push, and pull run Git on that host. In-progress merges, rebases, and cherry-picks are read from the remote repository. SSH remote repositories are grouped under their own sidebar heading.

- Open the remote repository in your terminal. Ignore files and edit `.gitignore` on the host. A symbolic link is not followed.

- [#293] You can now set the default editor to "Use system default program". This is useful in media-heavy repositories where you want to use the system-defined program when double-clicking a file in the changes list.  
   You can set this globally in "File > Options > Integrations > External Editor", or per-repository in "File > Repository Options > Integrations > Custom External Editor".

- [#297] You can now revert multiple commits at once.  
  Simply select the commits you want to revert in the history view, right-click, and select "Revert changes in commits".

- [#299] You can now cherry-pick commits to multiple branches at once.  
  Right-click on the commit you want to cherry-pick, select "Cherry-pick commit...", and then select the branches you want to cherry-pick to.

- [#292] Inverted the order of the "Pull all" and "Add" buttons in the repository list. This should reduce the number of accidental "Pull all" clicks for new users coming from GitHub Desktop.

## Fixes:

- The SSH destination is separated with `--`, so a user name that starts with `-` cannot be parsed as an extra ssh option.
- Conflict-resolution diffs for SSH repositories run on this machine. The comparison uses the local temporary files and does not inherit `core.autocrlf` from the directory Desktop was launched from.
- macOS x64 and Windows arm64 installers build again. The main and crash processes no longer bundle the Copilot native module (`koffi.node`).

## Known limitations:

- Reveal in Finder or Explorer and external editors stay unavailable for SSH repositories. They need a local working copy.
- Push and pull use the credentials configured on the remote machine.
- Warp, Hyper, Tabby, Black Box, and COSMIC Terminal cannot be given the SSH command. Choose another shell in Options.

## Installers:

Builds from this fork are for macOS and Windows.
