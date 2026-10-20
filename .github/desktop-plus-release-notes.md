Desktop Plus v3.6.8-beta3

## Changes and improvements:

- Connect to an SSH host and add a Git repository that lives on that machine. Type `user@host`, and a port or identity file only when you need them. Desktop does not read `~/.ssh/config` to offer a list of hosts. The system OpenSSH client still uses your keys, agent, and `known_hosts`.

- The repository list marks the repository with an SSH badge. Status, diff, commit, checkout, creating a branch, push, and pull run Git on that host. In-progress merges, rebases, and cherry-picks are read from the remote repository.

- Open the remote repository in your terminal. Ignore files and edit `.gitignore` on the host. A symbolic link is not followed.

## Known limitations:

- Reveal in Finder or Explorer and external editors stay unavailable. They need a local working copy.
- Push and pull use the credentials configured on the remote machine.
- Warp, Hyper, Tabby, Black Box, and COSMIC Terminal cannot be given the SSH command. Choose another shell in Options.
