Desktop Plus v3.6.8-beta6

## Changes and improvements:

- Connect to an SSH host and add a Git repository that lives on that machine. Desktop lists Host aliases from `~/.ssh/config` and its `Include` files. Pick an alias, or type the destination yourself (`user@host`, or only a Host alias). Add a port or identity file only when you need them. The saved connection stores the resolved user, host, port, and key. The system OpenSSH client still uses your keys, agent, and `known_hosts`.

- The repository list marks the repository with an SSH badge. Status, diff, commit, checkout, creating a branch, push, and pull run Git on that host. In-progress merges, rebases, and cherry-picks are read from the remote repository.

- Open the remote repository in your terminal. Ignore files and edit `.gitignore` on the host. A symbolic link is not followed.

## Changes since v3.6.8-beta5:

- SSH remote repositories are grouped under their own sidebar heading, instead of under Other.

## Fixes since v3.6.8-beta4:

- macOS x64 and Windows arm64 installers build again. The main and crash processes no longer bundle the Copilot native module (`koffi.node`).

## Fixes since v3.6.8-beta3:

- The SSH destination is separated with `--`, so a user name that starts with `-` cannot be parsed as an extra ssh option.
- Conflict-resolution diffs for SSH repositories run on this machine. The comparison uses the local temporary files and does not inherit `core.autocrlf` from the directory Desktop was launched from.

## Known limitations:

- Reveal in Finder or Explorer and external editors stay unavailable for SSH repositories. They need a local working copy.
- Push and pull use the credentials configured on the remote machine.
- Warp, Hyper, Tabby, Black Box, and COSMIC Terminal cannot be given the SSH command. Choose another shell in Options.

## Installers:

Builds from this fork are for macOS and Windows.
