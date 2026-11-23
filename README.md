# dsh-ssh-plugin

SSH remote control for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a Host-only plugin that lets the agent run commands, copy files, and drive
interactive shells on other machines through the local OpenSSH client.

- Uses the `Host` aliases, keys, and `ssh-agent` already configured on the
  machine. The plugin stores no credentials and never edits `~/.ssh/config`.
- Adds four model-facing tools: `ssh_hosts`, `ssh_exec`, `ssh_copy`, and
  `ssh_session`.
- No UI; the tools are available to every session in the DSH profile.

## Requirements

- DeepSeek Harness `0.2.3-alpha.2` or a compatible release
  (`engines.dsh: ^0.2.3-alpha.2`).
- An OpenSSH client (`ssh`, `scp`) on the machine that runs DSH.
- Non-interactive authentication: keys in `~/.ssh/` or `ssh-agent`. Connections
  always pass `BatchMode=yes`, so password and keyboard-interactive prompts are
  not supported.
- Network reachability to the target hosts (LAN, VPN, or a bastion).

## Installation

1. Clone the repository:

   ```sh
   git clone git@github.com:palmfuture/dsh-ssh-plugin.git
   ```

2. In DSH Desktop, open **Plugins** → **Add plugin** and choose the cloned
   directory. Or install it from the plugin manager with the absolute directory
   path as the target.

3. Make sure the **SSH remote control** row is enabled. The bundle inserts one
   row, `ssh-remote`, with its default config.

The installation links the directory instead of copying it, so editing the
files and recomposing the profile (toggle the row in **Plugins**) reloads the
plugin without reinstalling. Disabling it removes all four tools and closes
every open session.

## Tools

| Tool | Purpose |
| --- | --- |
| `ssh_hosts` | Lists literal `Host` aliases from `~/.ssh/config` with their `HostName`, `User`, `Port`, `IdentityFile`, and `ProxyJump` settings, plus non-hashed names recorded in `~/.ssh/known_hosts`. |
| `ssh_exec` | Runs one shell command on one or more hosts in parallel and returns each host's stdout, stderr, exit status, timeout flag, and truncation flags. |
| `ssh_copy` | Uploads or downloads a file or directory with `scp`. |
| `ssh_session` | Opens an interactive remote shell with an allocated remote terminal, then writes, reads, interrupts, closes, or lists sessions. |

### `ssh_hosts`

Discovers destinations the machine can use. The config file may be missing;
`known_hosts` names are hosts the machine has connected to, not verified shell
accounts. Pass any returned name, or `user@host`, to the other tools.

### `ssh_exec`

- `hosts`: array of destinations, at most 32 per call.
- `command`: shell command executed by the remote login shell.
- `cwd`: absolute remote directory to `cd` into first.
- `timeoutMs`: per-host timeout; the SSH client is terminated on expiry.

Hosts run in parallel up to `maxConcurrency`. A failure on one host does not
cancel the others. Each stream keeps its last configured characters, and a
per-call limit (`maxResultBytes`) bounds the combined output, so a many-host
call keeps fewer characters per stream. Truncated output is not spilled; re-run
a narrower command such as `head`, `tail`, or `grep`.

Use `ssh_exec` for one-shot commands. For streaming or input-waiting commands
(`tail -f`, `top`, a REPL), use `ssh_session`: `ssh_exec` waits for the command
to finish and then hits its timeout.

### `ssh_copy`

- `host`, `direction` (`upload` or `download`), `localPath`, `remotePath`.
- `recursive`: copy a directory tree.

A relative `localPath` resolves against the session workspace; a relative
`remotePath` resolves against the remote home directory. The parent directory
of the destination must exist, and a timeout can leave a partial destination
file. The copy runs as the Host user outside the session file sandbox, so
`localPath` is not confined to the workspace.

### `ssh_session`

Actions: `open`, `write`, `read`, `interrupt`, `close`, `list`.

- `open` starts a session, waits briefly for the first output or exit, and
  returns its `sessionId`. An authentication failure is reported here instead of
  appearing as a successful open.
- `write` sends input, appending a newline unless the input already ends with
  one. Remote prompts such as `sudo` can be answered this way.
- `read` returns output produced since the previous read, waiting up to `waitMs`
  (default 2000, maximum 30000). It waits for a short quiet period after output
  arrives, so one read usually returns a whole burst.
- `interrupt` sends Ctrl-C to the remote foreground process, not to the local
  SSH client.
- `close` terminates the session and returns unread output.
- `list` shows this agent's sessions.

At most `maxSessionsPerAgent` sessions may be open per agent. Terminal control
sequences are stripped and output is bounded by `sessionBufferBytes`.

## Example prompts

- "Check disk usage on dell.lan and spark.lan."
- "Show the last 50 lines of `/var/log/syslog` on cluster.lan."
- "Open a shell on spark.lan, run `nvidia-smi`, and show the output."
- "Copy `build.tar.gz` to `/tmp` on cluster.lan."
- "Which SSH hosts can you reach?"

## Configuration

The `ssh-remote` row accepts these fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `sshPath` | `ssh` | SSH executable; a bare name is searched in `PATH` and the usual system directories. |
| `scpPath` | `scp` | SCP executable. |
| `connectTimeoutSeconds` | `10` | `ConnectTimeout` passed to every connection. |
| `defaultTimeoutMs` | `120000` | Timeout for `ssh_exec` when the call omits `timeoutMs`, and for `ssh_copy`. |
| `maxTimeoutMs` | `600000` | Upper bound applied to a call's `timeoutMs`. |
| `maxOutputBytes` | `100000` | Retained characters per stream; longer output keeps the tail and sets the truncation flag. |
| `maxResultBytes` | `200000` | Combined output bound for one `ssh_exec` call, divided across hosts and streams. |
| `strictHostKeyChecking` | `accept-new` | One of `yes`, `no`, `ask`, `accept-new`, `off`. |
| `extraOptions` | `[]` | Additional `ssh`/`scp` arguments, for example `-o ProxyCommand=...`. |
| `maxConcurrency` | `4` | Maximum hosts `ssh_exec` talks to at once. |
| `maxSessionsPerAgent` | `4` | Maximum live `ssh_session` sessions per agent. |
| `sessionBufferBytes` | `262144` | Retained interactive output per session; older output is dropped and reported. |

Edit the row in the profile patch (`cordis.patch.yml`) or the bundle's
`cordis.patch.yml`, then recompose. An id-targeted override replaces the whole
config, so include every field you want to keep.

## Authentication and host keys

Connections run with `BatchMode=yes`: keys or `ssh-agent` only. A host that needs
a password, a passphrase prompt, or an interactive host-key confirmation fails
fast and returns its `stderr` to the model instead of hanging.

Host keys follow `StrictHostKeyChecking` (`accept-new` by default). Once the
target hosts are in `known_hosts`, set it to `yes` to reject unknown keys.

## Security notes

- `ssh` and `scp` run as the Host user outside the session file sandbox. Local
  paths passed to `ssh_copy` are not confined to the workspace.
- Remote commands run with the remote user's privileges. Use `ssh_session` when
  a remote prompt needs an answer; do not pass secrets in command lines that
  will be logged.
- The plugin never reads or stores private keys itself; it only invokes the
  OpenSSH client.

## Limitations

- No password or keyboard-interactive authentication, port forwarding, agent
  forwarding, or SFTP resume.
- `ssh_hosts` reads only the main `~/.ssh/config`: `Include` files, wildcard
  patterns, and `Match` blocks are ignored.
- No connection multiplexing (ControlMaster); every call opens a new SSH
  connection.
- Interactive output is stripped of control sequences and bounded; there is no
  window resizing.
- Truncated `ssh_exec` output is not spilled to a file.

## Development

The plugin is plain ESM with no build step and no runtime dependencies.

```sh
node --check index.js
```

To try changes, edit the files and recompose the profile (toggle the row in
**Plugins**); the installed directory is linked to the profile.

## License

MIT — see [LICENSE](LICENSE).
