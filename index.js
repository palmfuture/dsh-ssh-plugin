/**
 * SSH remote-control tools for DeepSeek Harness.
 *
 * Registers four Host tools that drive the local OpenSSH client:
 * - `ssh_hosts`: lists Host aliases from ~/.ssh/config and names from ~/.ssh/known_hosts
 * - `ssh_exec`: runs one command on one or more hosts in parallel
 * - `ssh_copy`: copies files or directories with scp
 * - `ssh_session`: opens and drives interactive remote shells (`ssh -tt`)
 *
 * Authentication is non-interactive: keys or ssh-agent only (BatchMode). The
 * plugin holds no credentials and never writes the user's SSH configuration.
 *
 * @module @local/ssh-remote
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export const name = 'ssh-remote'
export const inject = ['tools']

/** Defaults for the row's `config`; every field is clamped by normalizeConfig. */
const DEFAULT_CONFIG = {
  sshPath: 'ssh',
  scpPath: 'scp',
  connectTimeoutSeconds: 10,
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 100_000,
  maxResultBytes: 200_000,
  strictHostKeyChecking: 'yes',
  extraOptions: [],
  maxConcurrency: 4,
  maxSessionsPerAgent: 4,
  sessionBufferBytes: 262_144,
  confineLocalPaths: true,
  localPathRoot: '',
  maxConfigBytes: 1_048_576,
}

/** Accepted StrictHostKeyChecking values for OpenSSH. */
const STRICT_HOST_KEY_VALUES = ['yes', 'no', 'ask', 'accept-new', 'off']

/** ANSI escape sequences (CSI, OSC, charset selectors) removed from terminal output. */
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-_])/g

/**
 * Normalize the plugin row's config, replacing invalid values with defaults.
 * @param {unknown} raw - the row's `config` object.
 * @returns {typeof DEFAULT_CONFIG} the effective config.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const integer = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(parsed)))
  }
  const text = (value, fallback) => typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  const maxTimeoutMs = integer(source.maxTimeoutMs, DEFAULT_CONFIG.maxTimeoutMs, 1_000, 3_600_000)
  const rawStrict = text(source.strictHostKeyChecking, DEFAULT_CONFIG.strictHostKeyChecking)
  return {
    sshPath: text(source.sshPath, DEFAULT_CONFIG.sshPath),
    scpPath: text(source.scpPath, DEFAULT_CONFIG.scpPath),
    connectTimeoutSeconds: integer(source.connectTimeoutSeconds, DEFAULT_CONFIG.connectTimeoutSeconds, 1, 300),
    defaultTimeoutMs: Math.min(integer(source.defaultTimeoutMs, DEFAULT_CONFIG.defaultTimeoutMs, 1_000, maxTimeoutMs), maxTimeoutMs),
    maxTimeoutMs,
    maxOutputBytes: integer(source.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes, 1_000, 1_000_000),
    maxResultBytes: integer(source.maxResultBytes, DEFAULT_CONFIG.maxResultBytes, 1_000, 2_000_000),
    strictHostKeyChecking: STRICT_HOST_KEY_VALUES.includes(rawStrict) ? rawStrict : DEFAULT_CONFIG.strictHostKeyChecking,
    extraOptions: Array.isArray(source.extraOptions)
      ? source.extraOptions.filter(entry => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim())
      : [],
    maxConcurrency: integer(source.maxConcurrency, DEFAULT_CONFIG.maxConcurrency, 1, 16),
    maxSessionsPerAgent: integer(source.maxSessionsPerAgent, DEFAULT_CONFIG.maxSessionsPerAgent, 1, 16),
    sessionBufferBytes: integer(source.sessionBufferBytes, DEFAULT_CONFIG.sessionBufferBytes, 4_096, 1_048_576),
    confineLocalPaths: typeof source.confineLocalPaths === 'boolean' ? source.confineLocalPaths : DEFAULT_CONFIG.confineLocalPaths,
    localPathRoot: typeof source.localPathRoot === 'string' ? source.localPathRoot.trim() : DEFAULT_CONFIG.localPathRoot,
    maxConfigBytes: integer(source.maxConfigBytes, DEFAULT_CONFIG.maxConfigBytes, 1_024, 16_777_216),
  }
}

/**
 * Whether a directory is writable by a user other than its owner. A POSIX
 * directory that anyone can write to is an unsafe place to resolve an
 * executable from.
 * @param {string} directory - directory to inspect.
 * @returns {boolean} true when group or other write bits are set.
 */
function isWritableByOthers(directory) {
  try {
    return (statSync(directory).mode & 0o022) !== 0
  } catch {
    return true
  }
}

/**
 * Resolve an SSH-family executable. Bare names prefer the system directories
 * before PATH and skip directories that group or others can write to, so a
 * hijacked PATH entry cannot substitute the binary. When no safe candidate
 * exists, the first existing candidate is used as a last resort.
 * @param {string} command - configured executable name or path.
 * @returns {string} a resolved path, or the original bare name.
 */
function resolveBinary(command) {
  if (command.includes('/') || command.includes('\\')) return command
  const trusted = process.platform === 'win32' ? [] : ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']
  const seen = new Set()
  const directories = []
  for (const directory of [...trusted, ...(process.env.PATH ?? '').split(delimiter)]) {
    if (directory === '' || seen.has(directory)) continue
    seen.add(directory)
    directories.push(directory)
  }
  const existing = directories.map(directory => resolve(directory, command)).filter(candidate => existsSync(candidate))
  const safe = process.platform === 'win32'
    ? existing
    : existing.filter(candidate => !isWritableByOthers(dirname(candidate)))
  return safe[0] ?? existing[0] ?? command
}

/**
 * Quote one value for a POSIX remote shell.
 * @param {string} value - the raw value.
 * @returns {string} single-quoted shell word.
 */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Strip terminal control sequences and normalize CRLF from remote output.
 * @param {string} text - raw terminal text.
 * @returns {string} readable text.
 */
function stripTerminalControl(text) {
  return text.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n').replace(/\r/g, '')
}

/**
 * Append text to a bounded tail buffer.
 * @param {{ text: string, truncated: boolean }} state - the stream state.
 * @param {string} chunk - decoded text.
 * @param {number} maxBytes - maximum retained characters.
 */
function appendCapped(state, chunk, maxBytes) {
  if (chunk === '') return
  state.text += chunk
  if (state.text.length > maxBytes) {
    state.text = state.text.slice(state.text.length - maxBytes)
    state.truncated = true
  }
}

/**
 * Throw a model-correctable argument error.
 * @param {string[]} violations - path-qualified problems.
 * @returns {never}
 */
function argsError(violations) {
  const error = new Error(`invalid arguments: ${violations.join('; ')}`)
  error.name = 'ToolArgsError'
  error.code = 'INVALID_ARGS'
  throw error
}

/**
 * Throw the structured abort used when the caller cancels a tool call.
 * @returns {never}
 */
function abortedError() {
  const error = new Error('ssh call aborted')
  error.name = 'AbortError'
  error.code = 'ABORTED'
  throw error
}

/**
 * Validate one SSH destination.
 * @param {unknown} host - candidate destination.
 * @returns {string | undefined} a violation, or undefined when valid.
 */
function validateHost(host) {
  if (typeof host !== 'string' || host.trim() === '') return 'expected a non-empty SSH destination'
  if (host.startsWith('-')) return 'must not start with "-" (it would be read as an ssh option)'
  if (/[\s\x00-\x1f]/.test(host)) return 'must not contain whitespace or control characters'
  return undefined
}

/**
 * Run one local process to completion with bounded tail output.
 * @param {object} options - run options.
 * @param {string[]} options.argv - executable and arguments.
 * @param {string} options.cwd - working directory.
 * @param {number} options.timeoutMs - timeout in milliseconds.
 * @param {AbortSignal} options.signal - caller cancellation.
 * @param {number} options.maxBytes - retained characters per stream.
 * @returns {Promise<object>} exit facts and bounded output; never rejects for spawn failures.
 */
function runProcess({ argv, cwd, timeoutMs, signal, maxBytes }) {
  return new Promise((resolveResult) => {
    const stdout = { text: '', truncated: false }
    const stderr = { text: '', truncated: false }
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    let timedOut = false
    let aborted = false
    let settled = false
    let timer
    let killTimer
    let child

    const clearTimers = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      timer = undefined
      killTimer = undefined
    }
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimers()
      signal.removeEventListener('abort', onAbort)
      resolveResult({ stdout: stdout.text, stderr: stderr.text, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated, timedOut, aborted, ...outcome })
    }
    const terminate = () => {
      try {
        child.kill('SIGTERM')
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, 5_000)
      killTimer.unref?.()
    }
    const onAbort = () => {
      aborted = true
      terminate()
    }

    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], cwd, env: process.env })
    } catch (error) {
      resolveResult({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    child.stdout.on('data', chunk => { appendCapped(stdout, outDecoder.write(chunk), maxBytes) })
    child.stderr.on('data', chunk => { appendCapped(stderr, errDecoder.write(chunk), maxBytes) })
    child.on('error', error => {
      finish({
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    child.on('close', (code, signalName) => {
      appendCapped(stdout, outDecoder.end(), maxBytes)
      appendCapped(stderr, errDecoder.end(), maxBytes)
      finish({ exitCode: code, signal: signalName })
    })

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    timer.unref?.()
  })
}

/**
 * Run a worker over items with bounded concurrency.
 * @param {unknown[]} items - work items.
 * @param {number} limit - maximum concurrent workers.
 * @param {(item: unknown, index: number) => Promise<unknown>} worker - async work.
 * @returns {Promise<unknown[]>} results in item order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Read and parse Host blocks from ~/.ssh/config. Wildcard and negated
 * patterns are skipped because they cannot be used as a literal destination.
 * @param {string} text - the config file contents.
 * @returns {object[]} literal Host aliases with their effective settings.
 */
function parseSshConfig(text) {
  const hosts = []
  let currentHosts = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue
    const match = /^(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'host') {
      currentHosts = []
      for (const pattern of value.split(/\s+/)) {
        if (pattern === '' || pattern.startsWith('!') || /[*?]/.test(pattern)) continue
        const entry = { alias: pattern }
        hosts.push(entry)
        currentHosts.push(entry)
      }
      continue
    }
    if (key === 'match') {
      currentHosts = []
      continue
    }
    for (const entry of currentHosts) {
      if (key === 'hostname') entry.hostname = value
      else if (key === 'user') entry.user = value
      else if (key === 'port') {
        const port = Number(value)
        if (Number.isInteger(port) && port > 0) entry.port = port
      } else if (key === 'identityfile') entry.identityFile = value
      else if (key === 'proxyjump') entry.proxyJump = value
    }
  }
  return hosts
}

/**
 * Extract non-hashed host names from known_hosts text.
 * @param {string} text - known_hosts contents.
 * @returns {string[]} sorted unique host names.
 */
function parseKnownHosts(text) {
  const names = new Set()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const name = line.split(/\s+/)[0]
    if (name.startsWith('|') || name.startsWith('@')) continue
    names.add(name)
  }
  return [...names].sort()
}

/**
 * Register the SSH tools on the calling context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} config - the row's config.
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const sshBinary = resolveBinary(cfg.sshPath)
  const scpBinary = resolveBinary(cfg.scpPath)

  /** Live interactive sessions keyed by their model-facing id. */
  const sessions = new Map()
  let nextSessionId = 1

  const sshOptions = () => [
    '-o', `ConnectTimeout=${cfg.connectTimeoutSeconds}`,
    '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${cfg.strictHostKeyChecking}`,
    ...cfg.extraOptions,
  ]

  const ownerOf = exec => typeof exec.agent?.id === 'string' ? exec.agent.id : 'anonymous'

  /**
   * Resolve the local directory a call runs in: the session workspace when the
   * working-directory service is composed, otherwise the home directory.
   * @param {object} exec - tool run context.
   * @returns {string} an existing directory.
   */
  const localCwd = exec => {
    const service = ctx.get('workingDirectory')
    let directory
    if (service !== undefined) {
      try {
        const session = exec.agent?.session
        if (session !== undefined) directory = service.get(session)
        if (typeof directory !== 'string' || directory === '') directory = service.defaultDirectory
      } catch {}
    }
    if (typeof directory !== 'string' || directory === '' || !existsSync(directory)) directory = homedir()
    return directory
  }

  /** Kill every session owned by one agent id. */
  const closeSessionsFor = ownerId => {
    for (const [id, session] of sessions) {
      if (session.ownerId !== ownerId) continue
      try {
        session.child.kill('SIGKILL')
      } catch {}
      sessions.delete(id)
    }
  }

  /**
   * Append decoded output to one session's bounded buffer and wake readers.
   * @param {object} session - the live session.
   * @param {string} text - decoded output.
   */
  const pushSessionOutput = (session, text) => {
    if (text === '') return
    session.buffer += text
    if (session.buffer.length > cfg.sessionBufferBytes) {
      const drop = session.buffer.length - cfg.sessionBufferBytes
      session.buffer = session.buffer.slice(drop)
      session.readOffset = Math.max(0, session.readOffset - drop)
      session.dropped += drop
    }
    for (const waiter of [...session.waiters]) waiter()
    session.waiters.clear()
  }

  /**
   * Wait for the next output or exit, or until the timeout passes.
   * @param {object} session - the live session.
   * @param {number} waitMs - maximum wait in milliseconds.
   * @returns {Promise<void>} resolves on new output, exit, or timeout.
   */
  const waitForSessionChange = async (session, waitMs) => {
    if (waitMs <= 0) return
    await new Promise(resolveWait => {
      let timer
      const done = () => {
        if (timer !== undefined) clearTimeout(timer)
        session.waiters.delete(done)
        resolveWait()
      }
      session.waiters.add(done)
      timer = setTimeout(done, waitMs)
      timer.unref?.()
    })
  }

  /**
   * Wait until output arrives, then for a short quiet period, so one read
   * returns a burst of output instead of only its first chunk. Returns early
   * when the session exits or the total wait expires.
   * @param {object} session - the live session.
   * @param {number} waitMs - maximum total wait in milliseconds.
   * @returns {Promise<void>} resolves when output has settled or time is up.
   */
  const waitForSessionOutput = async (session, waitMs) => {
    const deadline = Date.now() + waitMs
    const quietMs = Math.min(200, waitMs)
    for (;;) {
      if (session.exited) return
      const remaining = deadline - Date.now()
      const hasOutput = session.buffer.length > session.readOffset
      if (hasOutput && remaining <= 0) return
      const slice = Math.min(remaining, quietMs)
      if (slice <= 0) return
      const length = session.buffer.length
      await waitForSessionChange(session, slice)
      if (session.exited) return
      if (session.buffer.length === length) {
        if (hasOutput) return
        if (Date.now() >= deadline) return
      }
    }
  }

  /**
   * Per-stream character limit for one call, so a many-host call cannot
   * overflow the model context.
   * @param {number} hostCount - destinations in the call.
   * @returns {number} retained characters per stream.
   */
  const streamLimitFor = hostCount => {
    const count = Number.isInteger(hostCount) && hostCount > 0 ? hostCount : 1
    return Math.max(1_000, Math.min(cfg.maxOutputBytes, Math.floor(cfg.maxResultBytes / (count * 2))))
  }

  /**
   * Read a small user-owned SSH file, refusing files above maxConfigBytes.
   * @param {string} path - file to read.
   * @returns {{ text?: string, skipped?: number }} text, or the size that was skipped.
   */
  const readBoundedText = path => {
    try {
      const size = statSync(path).size
      if (size > cfg.maxConfigBytes) return { skipped: size }
      return { text: readFileSync(path, 'utf8') }
    } catch {
      return {}
    }
  }

  /**
   * Resolve a local path for ssh_copy and enforce localPathRoot confinement.
   * Lexical containment plus a real-path check on the nearest existing
   * ancestor keeps symlinks from escaping the root.
   * @param {object} exec - tool run context.
   * @param {string} localPath - model-provided local path.
   * @returns {string} the absolute local path.
   */
  const resolveLocalPath = (exec, localPath) => {
    const absolute = isAbsolute(localPath) ? resolve(localPath) : resolve(localCwd(exec), localPath)
    if (!cfg.confineLocalPaths) return absolute
    const root = cfg.localPathRoot === '' ? localCwd(exec) : resolve(cfg.localPathRoot)
    const lexical = relative(root, absolute)
    const inside = lexical === '' || (!lexical.startsWith('..') && !isAbsolute(lexical))
    if (!inside) {
      argsError([`localPath ${JSON.stringify(localPath)} is outside ${root}; set confineLocalPaths: false to allow it`])
    }
    let probe = absolute
    while (!existsSync(probe)) {
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    try {
      const realRelative = relative(realpathSync(root), realpathSync(probe))
      const realInside = realRelative === '' || (!realRelative.startsWith('..') && !isAbsolute(realRelative))
      if (!realInside) {
        argsError([`localPath ${JSON.stringify(localPath)} resolves outside ${root} through a symlink; set confineLocalPaths: false to allow it`])
      }
    } catch {}
    return absolute
  }

  /**
   * Resolve one session and check that the caller owns it.
   * @param {unknown} sessionId - model-provided id.
   * @param {string} ownerId - calling agent id.
   * @returns {object} the live session.
   */
  const requireSession = (sessionId, ownerId) => {
    if (typeof sessionId !== 'string' || sessionId === '') argsError(['sessionId must be a non-empty string'])
    const session = sessions.get(sessionId)
    if (session === undefined) argsError([`unknown sessionId ${JSON.stringify(sessionId)}; call ssh_session with action "list"`])
    if (session.ownerId !== ownerId) argsError([`sessionId ${JSON.stringify(sessionId)} belongs to another agent`])
    return session
  }

  /**
   * Read new output from a session and advance its cursor.
   * @param {object} session - the live session.
   * @returns {{ output: string, exited: boolean, exitCode: number | null, dropped: number }} the delta.
   */
  const readSessionDelta = session => {
    const output = session.buffer.slice(session.readOffset)
    session.readOffset = session.buffer.length
    return { output, exited: session.exited, exitCode: session.exitCode, dropped: session.dropped }
  }

  /** Terminate all sessions when the plugin unloads. */
  ctx.effect(() => () => {
    for (const session of sessions.values()) {
      try {
        session.child.kill('SIGKILL')
      } catch {}
    }
    sessions.clear()
  })

  /** Release a disposed agent's sessions. */
  ctx.on('agent/disposed', ({ agent }) => { closeSessionsFor(agent.id) })

  ctx.tools.register({
    name: 'ssh_hosts',
    description: 'List SSH destinations this machine can discover: literal Host aliases from ~/.ssh/config with their HostName, User, Port, IdentityFile, and ProxyJump settings, plus non-hashed names recorded in ~/.ssh/known_hosts. The config file may be missing, and known_hosts names are hosts this machine has connected to, not verified shell accounts. Use a returned name as the host argument of ssh_exec, ssh_copy, and ssh_session.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['configPath', 'configExists', 'hosts', 'knownHosts', 'notes'],
        properties: {
          configPath: { type: 'string', description: 'Path to the SSH configuration file that was read.' },
          configExists: { type: 'boolean', description: 'Whether the configuration file exists.' },
          hosts: {
            type: 'array',
            description: 'Literal Host aliases and their effective settings.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['alias'],
              properties: {
                alias: { type: 'string' },
                hostname: { type: 'string' },
                user: { type: 'string' },
                port: { type: 'integer' },
                identityFile: { type: 'string' },
                proxyJump: { type: 'string' },
              },
            },
          },
          knownHosts: {
            type: 'array',
            description: 'Non-hashed host names recorded in known_hosts.',
            items: { type: 'string' },
          },
          notes: {
            type: 'array',
            description: 'Warnings about files that were skipped or could not be read.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`config: ${value.configPath}${value.configExists ? '' : ' (missing)'}`]
        const shownHosts = value.hosts.slice(0, 50)
        if (value.hosts.length === 0) {
          lines.push('Host aliases: none')
        } else {
          lines.push(`Host aliases (${value.hosts.length}):`)
          for (const host of shownHosts) {
            const details = [
              host.hostname !== undefined ? `hostname=${host.hostname}` : undefined,
              host.user !== undefined ? `user=${host.user}` : undefined,
              host.port !== undefined ? `port=${host.port}` : undefined,
              host.identityFile !== undefined ? `identity=${host.identityFile}` : undefined,
              host.proxyJump !== undefined ? `proxyJump=${host.proxyJump}` : undefined,
            ].filter(entry => entry !== undefined)
            lines.push(`- ${host.alias}${details.length > 0 ? ` (${details.join(', ')})` : ''}`)
          }
          if (value.hosts.length > shownHosts.length) lines.push(`(+${value.hosts.length - shownHosts.length} more aliases)`)
        }
        const shownKnown = value.knownHosts.slice(0, 50)
        if (value.knownHosts.length === 0) {
          lines.push('known_hosts names: none')
        } else {
          lines.push(`known_hosts names (${value.knownHosts.length}, recorded hosts, not verified shell accounts): ${shownKnown.join(', ')}${value.knownHosts.length > shownKnown.length ? `, +${value.knownHosts.length - shownKnown.length} more` : ''}`)
        }
        if (value.hosts.length === 0) lines.push('No config aliases: try a known_hosts name above, or user@host.')
        for (const note of value.notes) lines.push(`note: ${note}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const configPath = resolve(homedir(), '.ssh', 'config')
      const knownHostsPath = resolve(homedir(), '.ssh', 'known_hosts')
      const notes = []
      const configRead = readBoundedText(configPath)
      const knownRead = readBoundedText(knownHostsPath)
      let configExists = false
      let hosts = []
      if (configRead.skipped !== undefined) {
        configExists = true
        notes.push(`config skipped: ${configRead.skipped} bytes exceeds maxConfigBytes (${cfg.maxConfigBytes})`)
      } else if (configRead.text !== undefined) {
        configExists = true
        hosts = parseSshConfig(configRead.text)
      }
      let knownHosts = []
      if (knownRead.skipped !== undefined) {
        notes.push(`known_hosts skipped: ${knownRead.skipped} bytes exceeds maxConfigBytes (${cfg.maxConfigBytes})`)
      } else if (knownRead.text !== undefined) {
        knownHosts = parseKnownHosts(knownRead.text)
      }
      if (exec.signal.aborted) abortedError()
      return { configPath, configExists, hosts, knownHosts, notes }
    },
    presentCall() {
      return { card: 'generic', title: 'List SSH hosts', kind: 'search' }
    },
  })

  ctx.tools.register({
    name: 'ssh_exec',
    description: 'Run a shell command on one or more remote hosts over SSH and return each host\'s stdout, stderr, exit status, timeout flag, and truncation flags. Hosts run in parallel with bounded concurrency, at most 32 destinations per call. Use this for one-shot commands; for commands that stream output, wait for input, or run indefinitely (tail -f, top, a REPL), use ssh_session. Authentication is non-interactive (keys or ssh-agent only): a host that needs a password or host-key confirmation fails and reports its stderr instead of prompting. Commands run through the remote login shell; pass an absolute cwd to change directory first. Each stream keeps its last configured characters, and a per-call limit bounds the combined output; when output is truncated, re-run with a narrower command such as head, tail, or grep.',
    parameters: {
      type: 'object',
      properties: {
        hosts: {
          type: 'array',
          description: 'SSH destinations, one connection each: a Host alias from ~/.ssh/config or user@host. At most 32 per call.',
          items: { type: 'string', description: 'A Host alias from ~/.ssh/config or user@host.' },
        },
        command: { type: 'string', description: 'Shell command executed by the remote login shell on every host.' },
        cwd: { type: 'string', description: 'Absolute remote directory to change into before running the command; omit to keep the remote home directory.' },
        timeoutMs: { type: 'number', description: 'Per-host timeout in milliseconds; the SSH client is terminated on expiry. Defaults to the plugin\'s configured timeout; larger values are capped by the plugin maximum.' },
      },
      required: ['hosts', 'command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['results'],
        properties: {
          results: {
            type: 'array',
            description: 'One result per host, in the order the hosts were given.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['host', 'ok', 'exitCode', 'signal', 'timedOut', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated'],
              properties: {
                host: { type: 'string' },
                ok: { type: 'boolean', description: 'True only when the command exited 0.' },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                timedOut: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                stdoutTruncated: { type: 'boolean' },
                stderrTruncated: { type: 'boolean' },
                error: { type: 'string', description: 'Present when the SSH client could not be started or failed to connect.' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const sections = []
        for (const result of value.results) {
          const lines = []
          if (result.error !== undefined) {
            lines.push(`== ${result.host} — ssh error ==`, result.error)
          } else {
            const status = result.timedOut
              ? 'timed out (SSH client terminated)'
              : `exit ${result.exitCode}${result.signal !== null ? ` (signal ${result.signal})` : ''}`
            lines.push(`== ${result.host} — ${status} ==`)
            if (result.stdout !== '') lines.push(result.stdout.replace(/\n+$/, ''))
            if (result.stderr !== '') lines.push('[stderr]', result.stderr.replace(/\n+$/, ''))
            if (result.stdout === '' && result.stderr === '') lines.push('(no output)')
          }
          if (result.stdoutTruncated || result.stderrTruncated) lines.push('[output truncated to the configured per-stream limit; re-run with a narrower command such as head, tail, or grep]')
          sections.push(lines.join('\n'))
        }
        return [{ type: 'text', text: sections.join('\n\n') }]
      },
    },
    async execute(args, exec) {
      const violations = []
      if (args === null || typeof args !== 'object') argsError(['arguments must be an object'])
      if (!Array.isArray(args.hosts) || args.hosts.length === 0) violations.push('hosts must be a non-empty array of SSH destinations')
      else if (args.hosts.length > 32) violations.push('hosts accepts at most 32 destinations')
      else args.hosts.forEach((host, index) => {
        const violation = validateHost(host)
        if (violation !== undefined) violations.push(`hosts[${index}]: ${violation}`)
      })
      if (typeof args.command !== 'string' || args.command.trim() === '') violations.push('command must be a non-empty string')
      if (args.cwd !== undefined && (typeof args.cwd !== 'string' || args.cwd.trim() === '' || args.cwd.includes('\x00'))) violations.push('cwd must be a non-empty string without NUL characters')
      if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) violations.push('timeoutMs must be a positive number')
      if (violations.length > 0) argsError(violations)

      const timeoutMs = args.timeoutMs === undefined ? cfg.defaultTimeoutMs : Math.min(Math.trunc(args.timeoutMs), cfg.maxTimeoutMs)
      const streamLimit = streamLimitFor(args.hosts.length)
      const remoteCommand = args.cwd === undefined ? args.command : `cd ${shellQuote(args.cwd)} && ${args.command}`
      const cwd = localCwd(exec)

      const results = await mapLimit(args.hosts, cfg.maxConcurrency, async host => {
        if (exec.signal.aborted) {
          return {
            host,
            ok: false,
            exitCode: null,
            signal: null,
            timedOut: false,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            error: 'aborted',
          }
        }
        const outcome = await runProcess({
          argv: [sshBinary, ...sshOptions(), '--', host, remoteCommand],
          cwd,
          timeoutMs,
          signal: exec.signal,
          maxBytes: streamLimit,
        })
        return {
          host,
          ok: outcome.exitCode === 0 && outcome.error === undefined,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          timedOut: outcome.timedOut,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          stdoutTruncated: outcome.stdoutTruncated,
          stderrTruncated: outcome.stderrTruncated,
          ...outcome.error !== undefined ? { error: outcome.error } : {},
        }
      })

      if (exec.signal.aborted) abortedError()
      return { results }
    },
    presentCall(args) {
      if (args === null || typeof args !== 'object') return undefined
      const hosts = Array.isArray(args.hosts) ? args.hosts.filter(host => typeof host === 'string') : []
      const command = typeof args.command === 'string' ? args.command : ''
      const label = hosts.length > 3 ? `${hosts.slice(0, 3).join(', ')} +${hosts.length - 3} more` : hosts.join(', ')
      const view = {
        card: 'generic',
        title: hosts.length === 0 ? 'ssh' : `ssh ${label}`,
        kind: 'execute',
        rawInput: command,
      }
      if (command !== '') view.content = [{ type: 'text', text: command }]
      return view
    },
  })

  ctx.tools.register({
    name: 'ssh_copy',
    description: 'Copy a file or directory between this machine and a remote host over SCP. Uses the same non-interactive key authentication as ssh_exec. A relative localPath resolves against the session workspace; a relative remotePath resolves against the remote home directory. By default localPath is confined to the session workspace (or the configured localPathRoot); set confineLocalPaths: false to allow paths outside it. The parent directory of the destination must exist, and a timeout can leave a partial destination file. The copy runs as the Host user outside the session file sandbox.',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'SSH destination: a Host alias from ~/.ssh/config or user@host.' },
        direction: {
          type: 'string',
          enum: ['upload', 'download'],
          description: 'upload copies localPath to remotePath; download copies remotePath to localPath.',
        },
        localPath: { type: 'string', description: 'Path on this machine; a relative path resolves against the session workspace.' },
        remotePath: { type: 'string', description: 'Path on the remote host; a relative path resolves against the remote home directory.' },
        recursive: { type: 'boolean', description: 'Copy a directory and its contents recursively.' },
      },
      required: ['host', 'direction', 'localPath', 'remotePath'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['host', 'direction', 'localPath', 'remotePath', 'ok', 'exitCode', 'signal', 'timedOut', 'stderr'],
        properties: {
          host: { type: 'string' },
          direction: { type: 'string', enum: ['upload', 'download'] },
          localPath: { type: 'string' },
          remotePath: { type: 'string' },
          ok: { type: 'boolean' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          stderr: { type: 'string' },
          error: { type: 'string', description: 'Present when the SCP client could not be started.' },
        },
      },
      render: (_args, value) => {
        const status = value.timedOut ? 'timed out' : `exit ${value.exitCode}`
        const lines = [`${value.direction} ${value.localPath} ${value.direction === 'upload' ? '->' : '<-'} ${value.host}:${value.remotePath} — ${status}`]
        if (value.error !== undefined) lines.push(`[error] ${value.error}`)
        if (value.stderr !== '') lines.push('[stderr]', value.stderr.replace(/\n+$/, ''))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const violations = []
      if (args === null || typeof args !== 'object') argsError(['arguments must be an object'])
      const hostViolation = validateHost(args.host)
      if (hostViolation !== undefined) violations.push(`host: ${hostViolation}`)
      if (args.direction !== 'upload' && args.direction !== 'download') violations.push('direction must be "upload" or "download"')
      for (const key of ['localPath', 'remotePath']) {
        if (typeof args[key] !== 'string' || args[key].trim() === '' || args[key].includes('\x00')) violations.push(`${key} must be a non-empty string without NUL characters`)
      }
      if (args.recursive !== undefined && typeof args.recursive !== 'boolean') violations.push('recursive must be a boolean')
      if (violations.length > 0) argsError(violations)

      const cwd = localCwd(exec)
      const localPath = resolveLocalPath(exec, args.localPath)
      const remoteSpec = `${args.host}:${args.remotePath}`
      const source = args.direction === 'upload' ? localPath : remoteSpec
      const destination = args.direction === 'upload' ? remoteSpec : localPath
      const outcome = await runProcess({
        argv: [scpBinary, '-q', ...sshOptions(), ...(args.recursive === true ? ['-r'] : []), '--', source, destination],
        cwd,
        timeoutMs: cfg.defaultTimeoutMs,
        signal: exec.signal,
        maxBytes: cfg.maxOutputBytes,
      })
      if (exec.signal.aborted) abortedError()
      return {
        host: args.host,
        direction: args.direction,
        localPath,
        remotePath: args.remotePath,
        ok: outcome.exitCode === 0 && outcome.error === undefined,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        stderr: outcome.stderr,
        ...outcome.error !== undefined ? { error: outcome.error } : {},
      }
    },
    presentCall(args) {
      if (args === null || typeof args !== 'object') return undefined
      if (typeof args.localPath !== 'string' || typeof args.host !== 'string') return undefined
      return {
        card: 'generic',
        title: `scp ${args.direction === 'download' ? 'download from' : 'upload to'} ${args.host}`,
        kind: 'execute',
        rawInput: args,
      }
    },
  })

  ctx.tools.register({
    name: 'ssh_session',
    description: 'Open and drive an interactive remote shell over SSH with an allocated remote terminal. Use this for commands that stream output, wait for input, or run indefinitely; use ssh_exec for one-shot commands. Actions: "open" starts a session on a host, waits briefly for the first output or exit, and returns its sessionId; "write" sends input to it, appending a newline unless the input already ends with one; "read" returns output produced since the previous read, waiting up to waitMs for new output; "interrupt" sends Ctrl-C; "close" terminates the session and returns any unread output; "list" shows this agent\'s sessions. Authentication is non-interactive (keys or ssh-agent only). Answer non-secret prompts such as yes/no confirmations with write; never send passwords, passphrases, or tokens, because tool input is persisted in the session log. Use key-based sudo (NOPASSWD) for privileged commands. Terminal control sequences are stripped and only the last configured characters of output are retained. A session also ends when its remote command finishes or the connection drops.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'write', 'read', 'interrupt', 'close', 'list'],
          description: 'The session operation to perform.',
        },
        host: { type: 'string', description: 'Required for "open": a Host alias from ~/.ssh/config or user@host.' },
        command: { type: 'string', description: 'Optional remote command for "open"; omit to get a login shell.' },
        sessionId: { type: 'string', description: 'Required for "write", "read", "interrupt", and "close"; the id returned by "open" or "list".' },
        input: { type: 'string', description: 'Required for "write": the text to send. Never include passwords, passphrases, or tokens; tool input is persisted in the session log.' },
        waitMs: { type: 'number', description: 'For "read": how long to wait for new output before returning, in milliseconds (default 2000, maximum 30000).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string' },
          sessionId: { type: 'string' },
          host: { type: 'string' },
          output: { type: 'string', description: 'New output since the previous read.' },
          exited: { type: 'boolean' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          dropped: { type: 'integer', description: 'Characters dropped from the front of the buffer so far.' },
          written: { type: 'integer', description: 'Characters sent, including the appended newline.' },
          sessions: {
            type: 'array',
            description: 'This agent\'s sessions, for "list".',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'host', 'exited', 'exitCode', 'pendingBytes', 'createdAt'],
              properties: {
                id: { type: 'string' },
                host: { type: 'string' },
                exited: { type: 'boolean' },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                pendingBytes: { type: 'integer', description: 'Unread characters in the buffer.' },
                createdAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        switch (value.action) {
          case 'open': {
            const lines = []
            if (value.exited && value.exitCode !== 0) {
              lines.push(`could not open ${value.host}: ssh exited with ${value.exitCode === null ? 'no exit code' : `exit ${value.exitCode}`}`)
            } else if (value.exited) {
              lines.push(`session ${value.sessionId} on ${value.host} ended immediately (exit 0)`)
            } else if (value.output === '') {
              lines.push(`opened ${value.sessionId} on ${value.host} (connection not yet confirmed; read to check for output or an authentication error)`)
            } else {
              lines.push(`opened ${value.sessionId} on ${value.host}`)
            }
            if (value.output !== '') lines.push(value.output.replace(/\n+$/, ''))
            return [{ type: 'text', text: lines.join('\n') }]
          }
          case 'write':
            return [{ type: 'text', text: `wrote ${value.written} characters to ${value.sessionId}` }]
          case 'read': {
            const lines = [`== ${value.sessionId} ==`]
            if (value.output !== '') lines.push(value.output.replace(/\n+$/, ''))
            if (value.exited) lines.push(`[session exited with ${value.exitCode === null ? 'no exit code' : `exit ${value.exitCode}`}]`)
            else if (value.output === '') lines.push('(no new output; session still running — read again with a larger waitMs)')
            if (value.dropped > 0) lines.push(`[${value.dropped} characters were dropped from the buffer]`)
            return [{ type: 'text', text: lines.join('\n') }]
          }
          case 'interrupt':
            return [{ type: 'text', text: `sent Ctrl-C to ${value.sessionId}` }]
          case 'close': {
            const lines = [`closed ${value.sessionId}`]
            if (value.output !== '') lines.push(value.output.replace(/\n+$/, ''))
            return [{ type: 'text', text: lines.join('\n') }]
          }
          case 'list':
            if (value.sessions.length === 0) return [{ type: 'text', text: 'no SSH sessions' }]
            return [{
              type: 'text',
              text: value.sessions.map(session => `${session.id} ${session.host}${session.exited ? ` (exited ${session.exitCode})` : ''} unread=${session.pendingBytes}`).join('\n'),
            }]
          default:
            return [{ type: 'text', text: `ssh_session ${value.action}` }]
        }
      },
    },
    async execute(args, exec) {
      const actions = ['open', 'write', 'read', 'interrupt', 'close', 'list']
      if (args === null || typeof args !== 'object') argsError(['arguments must be an object'])
      if (!actions.includes(args.action)) argsError([`action must be one of ${actions.map(action => JSON.stringify(action)).join(', ')}`])
      const ownerId = ownerOf(exec)
      if (exec.signal.aborted) abortedError()

      switch (args.action) {
        case 'open': {
          const hostViolation = validateHost(args.host)
          if (hostViolation !== undefined) argsError([`host: ${hostViolation}`])
          if (args.command !== undefined && (typeof args.command !== 'string' || args.command.includes('\x00'))) argsError(['command must be a string without NUL characters'])
          const owned = [...sessions.values()].filter(session => session.ownerId === ownerId).length
          if (owned >= cfg.maxSessionsPerAgent) argsError([`this agent already has ${owned} open SSH sessions (limit ${cfg.maxSessionsPerAgent}); close one with action "close"`])

          const argv = [sshBinary, '-tt', ...sshOptions(), '--', args.host]
          if (typeof args.command === 'string' && args.command.trim() !== '') argv.push(args.command)
          let child
          try {
            child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], cwd: localCwd(exec), env: process.env })
          } catch (error) {
            argsError([`could not start ssh: ${error instanceof Error ? error.message : String(error)}`])
          }
          const session = {
            id: `ssh-${nextSessionId++}`,
            host: args.host,
            ownerId,
            child,
            buffer: '',
            readOffset: 0,
            dropped: 0,
            exited: false,
            exitCode: null,
            waiters: new Set(),
            outDecoder: new StringDecoder('utf8'),
            errDecoder: new StringDecoder('utf8'),
            createdAt: Date.now(),
          }
          sessions.set(session.id, session)
          child.stdin.on('error', () => {})
          child.stdout.on('data', chunk => { pushSessionOutput(session, stripTerminalControl(session.outDecoder.write(chunk))) })
          child.stderr.on('data', chunk => { pushSessionOutput(session, stripTerminalControl(session.errDecoder.write(chunk))) })
          child.on('error', error => {
            pushSessionOutput(session, `ssh error: ${error instanceof Error ? error.message : String(error)}\n`)
            session.exited = true
          })
          child.on('close', (code, signalName) => {
            pushSessionOutput(session, stripTerminalControl(session.outDecoder.end()) + stripTerminalControl(session.errDecoder.end()))
            session.exited = true
            session.exitCode = code
            session.signalName = signalName
            for (const waiter of [...session.waiters]) waiter()
            session.waiters.clear()
          })
          await waitForSessionOutput(session, 2_500)
          const delta = readSessionDelta(session)
          return {
            action: 'open',
            sessionId: session.id,
            host: session.host,
            output: delta.output,
            exited: delta.exited,
            exitCode: delta.exitCode,
          }
        }
        case 'write': {
          const session = requireSession(args.sessionId, ownerId)
          if (typeof args.input !== 'string' || args.input === '') argsError(['input must be a non-empty string'])
          if (session.exited) {
            const delta = readSessionDelta(session)
            const code = delta.exitCode === null ? 'no exit code' : `exit ${delta.exitCode}`
            const detail = delta.output.trim() === '' ? '' : `: ${delta.output.trim().slice(0, 500)}`
            argsError([`session ${session.id} has exited (${code})${detail}; open a new session`])
          }
          const payload = args.input.endsWith('\n') ? args.input : `${args.input}\n`
          try {
            session.child.stdin.write(payload)
          } catch (error) {
            argsError([`could not write to ${session.id}: ${error instanceof Error ? error.message : String(error)}`])
          }
          return { action: 'write', sessionId: session.id, written: payload.length }
        }
        case 'read': {
          const session = requireSession(args.sessionId, ownerId)
          if (args.waitMs !== undefined && (typeof args.waitMs !== 'number' || !Number.isFinite(args.waitMs) || args.waitMs < 0)) argsError(['waitMs must be a non-negative number'])
          const waitMs = Math.min(args.waitMs === undefined ? 2_000 : Math.trunc(args.waitMs), 30_000)
          await waitForSessionOutput(session, waitMs)
          const delta = readSessionDelta(session)
          return { action: 'read', sessionId: session.id, output: delta.output, exited: delta.exited, exitCode: delta.exitCode, dropped: delta.dropped }
        }
        case 'interrupt': {
          const session = requireSession(args.sessionId, ownerId)
          if (session.exited) argsError([`session ${session.id} has exited`])
          session.child.stdin.write('\x03')
          return { action: 'interrupt', sessionId: session.id }
        }
        case 'close': {
          const session = requireSession(args.sessionId, ownerId)
          const delta = readSessionDelta(session)
          try {
            session.child.kill('SIGTERM')
          } catch {}
          sessions.delete(session.id)
          return { action: 'close', sessionId: session.id, output: delta.output }
        }
        case 'list': {
          const listed = [...sessions.values()]
            .filter(session => session.ownerId === ownerId)
            .map(session => ({
              id: session.id,
              host: session.host,
              exited: session.exited,
              exitCode: session.exitCode,
              pendingBytes: session.buffer.length - session.readOffset,
              createdAt: session.createdAt,
            }))
          return { action: 'list', sessions: listed }
        }
        default:
          argsError([`unsupported action ${JSON.stringify(args.action)}`])
      }
    },
    presentCall(args) {
      if (args === null || typeof args !== 'object') return undefined
      const action = typeof args.action === 'string' ? args.action : 'session'
      const target = typeof args.host === 'string' ? args.host : typeof args.sessionId === 'string' ? args.sessionId : ''
      return { card: 'generic', title: `ssh session ${action}${target === '' ? '' : ` ${target}`}`, kind: 'execute', rawInput: args }
    },
  })
}
