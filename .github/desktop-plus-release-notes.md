Desktop Plus v3.6.12-beta2

Upstream:
- [GitHub Desktop 3.6.12-beta1 release notes](https://github.com/desktop/desktop/releases/tag/release-3.6.12-beta1)

## Changes and improvements:

- Connect to an SSH host and add a Git repository that lives on that machine. Desktop lists Host aliases from `~/.ssh/config` and its `Include` files. Pick an alias, or type the destination yourself (`user@host`, or only a Host alias). Add a port or identity file only when you need them. The saved connection stores the resolved user, host, port, and key. The system OpenSSH client still uses your keys, agent, and `known_hosts`.

- The repository list marks the repository with an SSH badge. Status, diff, commit, checkout, creating a branch, push, and pull run Git on that host. In-progress merges, rebases, and cherry-picks are read from the remote repository. SSH remote repositories are grouped under their own sidebar heading.

- Open the remote repository in your terminal. Ignore files and edit `.gitignore` on the host. A symbolic link is not followed.

- [#313] You can now independently choose different view modes (plain list or folder tree) in the Changes tab and the commit changes list. Previously, the choice of view mode was shared between the two lists.

- Refreshed the visual design of the view-mode toggles to make them less distracting and better fit into GitHub's design system.

## Fixes:

- The SSH destination is separated with `--`, so a user name that starts with `-` cannot be parsed as an extra ssh option.
- Conflict-resolution diffs for SSH repositories run on this machine. The comparison uses the local temporary files and does not inherit `core.autocrlf` from the directory Desktop was launched from.
- macOS x64 and Windows arm64 installers build again. The main and crash processes no longer bundle the Copilot native module (`koffi.node`).
- [#314] Fixed a visual bug that caused some rows in the Changes tab to disappear when the list shrinks while the app is not focused.
- [#316] Fix high CPU usage when multiple app windows are open and not focused.
- [#317] Fixed authentication issues when running `git` commands inside a Git hook script.

## Known limitations:

- Reveal in Finder or Explorer and external editors stay unavailable for SSH repositories. They need a local working copy.
- Push and pull use the credentials configured on the remote machine.
- Warp, Hyper, Tabby, Black Box, and COSMIC Terminal cannot be given the SSH command. Choose another shell in Options.

## Installers:

Builds from this fork are for macOS and Windows.
