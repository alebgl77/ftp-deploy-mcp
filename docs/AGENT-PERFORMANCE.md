# Agent performance and client integration

[Français](./AGENT-PERFORMANCE.fr.md)

The performance work reduces repeated local computation in the MCP server.
It applies to any client using its stdio tools, independently of the model
provider. The server architecture, tool names, arguments, response schemas,
transfer verification, cancellation and admission limits remain in place.

- The selected FTP/SFTP adapter loads on first use. Its import cost moves to
  the first connection; subsequent imports use Node's module cache.
- Each redactor caches sorted secret literals and compiled short-secret
  patterns, rebuilding them when a new distinct secret is collected. Extra
  storage grows with the number of secrets; replacement order and normal/strict
  behavior are preserved.
- Exact incremental JSON byte accounting avoids repeatedly serializing growing
  samples. Text truncation also avoids a duplicate full-result serialization.
  Response content and size limits are preserved.

## Connect an agent

Install from source as described in the [README](../README.md). Use Node.js 22
or newer and explicit absolute paths. This generic launch specification uses
the checkout as the process working directory and selects the server
configuration directly:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/ftp-deploy-mcp/src/index.js",
    "--config",
    "/absolute/path/to/ftp-servers.json"
  ],
  "cwd": "/absolute/path/to/ftp-deploy-mcp"
}
```

Adapt the surrounding configuration to the client. If it has no `cwd` setting,
set the launcher's working directory explicitly; keep both argument paths
absolute. `localRoot` in the server configuration determines the allowed local
file tree. `FTP_MCP_CONFIG` is an alternative to `--config`; the command-line
selector takes precedence. See [configuration](../README.md#server-configuration).

| Agent client | Integration route |
| --- | --- |
| Claude Code / Claude Desktop | Add the command and arguments under `mcpServers`; see [client setup](../README.md#client-setup). |
| OpenAI Agents SDK for JavaScript | Create `MCPServerStdio` with the launch options, connect it and attach it to the agent's `mcpServers`. Close it when finished. See the [SDK MCP guide](https://openai.github.io/openai-agents-js/guides/mcp/). |
| Gemini CLI | Add the launch options under `mcpServers` in `settings.json`; see the [Gemini CLI MCP guide](https://geminicli.com/docs/tools/mcp-server/). |
| Qwen-Agent | Supply a tool configuration containing `mcpServers` with the command and arguments; see the [Qwen-Agent MCP example](https://github.com/QwenLM/Qwen-Agent#how-to-use-mcp). |

These routes describe stdio compatibility; they are not provider-specific
end-to-end test results. Remote hosted MCP integrations require an accessible
HTTP MCP server or a separate bridge. This repository exposes stdio and adds
no HTTP server or bridge.

For a stable tool catalog, the OpenAI Agents SDK optionally accepts
`cacheToolsList: true` in `MCPServerStdio`. This avoids repeated client-side
tool discovery. Invalidate the cache with `invalidateToolsCache()` when the
catalog changes; see the [SDK caching guidance](https://openai.github.io/openai-agents-js/guides/mcp/#other-things-to-know).

## Keep calls focused

- Use `ftp_list` with an appropriate `limit` (default 50, maximum 200). Follow
  the returned `next_offset` only when more entries are needed. Pagination
  bounds the MCP response; the adapter still obtains the remote directory list.
- Use `ftp_read` with an explicit `max_bytes`, for example 8192 for a small
  configuration file. The default is 256 KiB and the hard maximum is 1 MiB.
- Await dependent mutations in sequence. For example, finish an upload before
  renaming its destination. Independent reads may overlap; the server's FIFO
  locks and [admission limits](./RESOURCE-BOUNDS.md) still apply.
- Review an `ftp_deploy` call with `dry_run: true` before executing the deploy.
  The dry run performs no network I/O and does not verify the remote endpoint.

Bounded, relevant responses and measurement of tool-call counts, runtime and
errors follow [Anthropic's tool design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents).

## Reproduce the checks

Run from a full repository checkout with development dependencies installed:

```bash
npm ci --ignore-scripts
npm run test:performance
npm test
npm run test:eval-runner
npm run eval:scripted
```

`test:performance` runs `test/redaction-performance.test.mjs` and
`test/agent-performance.test.mjs`; these regressions also run in `npm test`.

The runtime benchmark requires a pristine checkout as its first argument.
Create and install this baseline once, or use an existing checkout of the same
commit:

```bash
git worktree add --detach ../ftp-deploy-mcp-baseline a068aa5c3b1e53caaffc2c7907966ff5a2e9cb0f
npm --prefix ../ftp-deploy-mcp-baseline ci --ignore-scripts
npm run benchmark:agents -- ../ftp-deploy-mcp-baseline 200
```

The optional final argument is the positive iteration count (default 200).
`benchmark:agents` runs `scripts/benchmark-agent-performance.mjs` with local
fixtures, checks output equivalence, and reports serialization work and elapsed
time. Its discovery measurement covers module import, registration and tool
listing, not the complete stdio handshake. Record the commit, Node.js version,
operating system and workload alongside timings; repeat comparisons on the
same machine. On early Node.js 22 releases without module-load instrumentation,
hook-based checks are skipped and module counts are unavailable; benchmark
timings still run.

The redaction microbenchmark is opt-in and compares identical fixture outputs
with the previous implementation. It reports diagnostic medians without timing
assertions. On POSIX shells:

```bash
REDACTION_BENCHMARK=1 node --test test/redaction-performance.test.mjs
```

On PowerShell:

```powershell
$env:REDACTION_BENCHMARK = '1'
node --test test/redaction-performance.test.mjs
Remove-Item Env:REDACTION_BENCHMARK
```

The tests and benchmarks measure implementation behavior and local execution.
The [scripted evaluations](./SCRIPTED-EVALUATIONS.md) exercise MCP handlers
without a model. They do not establish model quality, token savings, provider
latency or production FTP/SFTP throughput. Use the separate
[agent evaluation instructions](../evaluations/README.md) for model-based work.
