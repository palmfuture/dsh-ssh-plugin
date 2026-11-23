# dsh-ssh-plugin

SSH remote control for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a Host-only plugin that lets the agent run commands, copy files, and drive
interactive shells on other machines through the local OpenSSH client.

- Uses the `Host` aliases, keys, and `ssh-agent` already configured on the
  machine. The plugin stores no credentials and never edits `~/.ssh/config`.
- Adds four model-facing tools: `ssh_hosts`, `ssh_exec`, `ssh_copy`, and
  `ssh_session`.
- No UI; the tools are available to every session in the DSH profile.
- No third-party runtime dependencies; only Node.js built-in modules.

## Requirements

- DeepSeek Harness `0.2.3-alpha.2` or a compatible release
  (`engines.dsh: ^0.2.3-alpha.2`).
- An OpenSSH client (`ssh`, `scp`) on the machine that runs DSH.
- Non-interactive authentication: keys in `~/.ssh/` or `ssh-agent`. Connections
  always pass `BatchMode=yes`, so password and keyboard-interactive prompts are
  not supported.
- Network reachability to the target hosts (LAN, VPN, or a bastion).
- Target host keys in `~/.ssh/known_hosts`. The plugin verifies host keys by
  default (`StrictHostKeyChecking=yes`); see
  [Authentication and host keys](#authentication-and-host-keys).

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

4. Add the host keys you intend to use (replace `host.example`):

   ```sh
   ssh-keyscan -H host.example >> ~/.ssh/known_hosts
   ```

   Alternatively, connect once manually with `ssh host.example`, compare the
   fingerprint with the host, and let the client add the key.

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
accounts. Pass any returned name, or `user@host`, to the other tools. Files
larger than `maxConfigBytes` are skipped and reported in `notes`.

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
`remotePath` resolves against the remote home directory. Local paths are
confined to the session workspace by default (`confineLocalPaths: true`), with
lexical and real-path containment checks; set `localPathRoot` to use a
different directory, or `confineLocalPaths: false` to allow any path (not
recommended). The parent directory of the destination must exist, and a timeout
can leave a partial destination file. The copy runs as the Host user outside
the session file sandbox.

### `ssh_session`

Actions: `open`, `write`, `read`, `interrupt`, `close`, `list`.

- `open` starts a session, waits briefly for the first output or exit, and
  returns its `sessionId`. An authentication failure is reported here instead of
  appearing as a successful open.
- `write` sends input, appending a newline unless the input already ends with
  one. **Never send passwords, passphrases, or tokens**: tool input is persisted
  in the session log. Answer only non-secret prompts such as `yes`/`no`.
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
| `sshPath` | `ssh` | SSH executable. A bare name resolves from system directories first, then from PATH entries that are not group- or world-writable. |
| `scpPath` | `scp` | SCP executable, resolved the same way. |
| `connectTimeoutSeconds` | `10` | `ConnectTimeout` passed to every connection. |
| `defaultTimeoutMs` | `120000` | Timeout for `ssh_exec` when the call omits `timeoutMs`, and for `ssh_copy`. |
| `maxTimeoutMs` | `600000` | Upper bound applied to a call's `timeoutMs`. |
| `maxOutputBytes` | `100000` | Retained characters per stream; longer output keeps the tail and sets the truncation flag. |
| `maxResultBytes` | `200000` | Combined output bound for one `ssh_exec` call, divided across hosts and streams. |
| `strictHostKeyChecking` | `yes` | One of `yes`, `no`, `ask`, `accept-new`, `off`. `accept-new` trusts a host key on first contact; use it only deliberately. |
| `extraOptions` | `[]` | Additional `ssh`/`scp` arguments, for example `-o ProxyCommand=...`. Trusted profile config only: these options can change client behavior. |
| `maxConcurrency` | `4` | Maximum hosts `ssh_exec` talks to at once. |
| `maxSessionsPerAgent` | `4` | Maximum live `ssh_session` sessions per agent. |
| `sessionBufferBytes` | `262144` | Retained interactive output per session; older output is dropped and reported. |
| `confineLocalPaths` | `true` | Confine `ssh_copy` local paths to `localPathRoot` (the session workspace when unset). |
| `localPathRoot` | `''` | Directory used as the confinement root; empty means the session workspace. |
| `maxConfigBytes` | `1048576` | Largest `~/.ssh/config` or `known_hosts` file the plugin will read; larger files are skipped and reported. |

Edit the row in the profile patch (`cordis.patch.yml`) or the bundle's
`cordis.patch.yml`, then recompose. An id-targeted override replaces the whole
config, so include every field you want to keep.

## Authentication and host keys

Connections run with `BatchMode=yes`: keys or `ssh-agent` only. A host that needs
a password, a passphrase prompt, or an interactive host-key confirmation fails
fast and returns its `stderr` to the model instead of hanging.

Host keys are verified against `known_hosts` (`StrictHostKeyChecking=yes` by
default). Populate the file before connecting to a new host:

```sh
ssh-keyscan -H host.example >> ~/.ssh/known_hosts
```

Verify the fingerprint out of band where possible. If you deliberately prefer
trust-on-first-use, set `strictHostKeyChecking: accept-new`; that accepts an
unknown key on first contact and rejects a changed key afterwards.

## Security notes

- `ssh` and `scp` run as the Host user outside the session file sandbox. Local
  paths are confined to the workspace by default, but the remote side runs with
  the remote user's privileges.
- Use a least-privilege remote account. For automation hosts, consider
  restricting `authorized_keys` entries with `from=` or `command=`.
- Do not type passwords, passphrases, or tokens into `ssh_session write`: tool
  input is persisted in the session log. Use key-based sudo (`NOPASSWD`) or a
  separate credential flow instead.
- `extraOptions` is trusted profile configuration. It can change client behavior
  (for example `ProxyCommand`), so never derive it from untrusted input.
- The plugin never reads or stores private keys; it only invokes the OpenSSH
  client.
- The bundle has no third-party dependencies, lockfile, or install scripts. See
  [SECURITY.md](SECURITY.md) for the reporting process and design notes.

## Limitations

- No password or keyboard-interactive authentication, port forwarding, agent
  forwarding, or SFTP resume.
- `ssh_hosts` reads only the main `~/.ssh/config`: `Include` files, wildcard
  patterns, and `Match` blocks are ignored.
- No connection multiplexing (ControlMaster); every call opens a new SSH
  connection.
- Truncated `ssh_exec` output is not spilled to a file.
- Interactive output is stripped of control sequences and bounded; there is no
  window resizing.
- A `ssh_copy` timeout can leave a partial destination file.
- Local path confinement is lexical plus a real-path check on the nearest
  existing ancestor; a symlink created after that check can still change the
  target.

## Development

The plugin is plain ESM with no build step and no runtime dependencies.

```sh
node --check index.js
```

To try changes, edit the files and recompose the profile (toggle the row in
**Plugins**); the installed directory is linked to the profile.

## Security policy

See [SECURITY.md](SECURITY.md) for supported versions and private reporting.

## License

MIT — see [LICENSE](LICENSE).
