# Security policy

## Supported versions

The `main` branch and the latest tagged release. Security fixes are applied to
`main` and released as a new version.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
<https://github.com/palmfuture/dsh-ssh-plugin/security/advisories/new>

Do not open a public issue for a vulnerability. Include the affected version,
reproduction steps, and the impact you observed. Expect an initial response
within 7 days.

## Scope

In scope:

- Argument construction and validation in `index.js`, including host
  validation, shell quoting, and local path confinement.
- The plugin's configuration handling, session management, and output bounds.
- Supply-chain concerns about the bundle itself.

Out of scope:

- The SSH server configuration or security of the remote hosts.
- The DeepSeek Harness runtime, the OpenSSH client, or the operating system.
- Credentials or private keys: the plugin never reads or stores them.

## Design notes

- No third-party runtime dependencies; only Node.js built-in modules.
- No install scripts, lockfiles, or `node_modules`.
- Authentication is non-interactive (`BatchMode=yes`): keys or `ssh-agent`.
- Host keys are verified against `known_hosts` (`StrictHostKeyChecking=yes` by
  default); `accept-new` is an explicit opt-in.
- `ssh` and `scp` binaries are resolved from system directories first and from
  PATH entries only when they are not group- or world-writable.
- Local `ssh_copy` paths are confined to the session workspace by default, with
  lexical and real-path containment checks.
