# Build Your Own Claude Code Plugin

A complete plugin in six steps. The example ships a slash command and an optional `PreToolUse` hook that blocks dangerous `rm -rf /` invocations before Bash runs them. The same scaffold extends to any workflow — swap the surface to fit the job.

**Pick a surface based on the workflow shape:**

- **Command** — user types `/name` to invoke a prompt deliberately
- **Hook** — fires automatically at a lifecycle point to observe, block, or inject context
- **Skill** — the model invokes it when its description matches the task
- **Agent** — a subagent with its own context for deeper, multi-step work

Reach for a hook when something must happen *every time* a trigger fires; a command when a human asks; a skill when the model should decide; an agent when the work warrants its own context.

## 1. Create the plugin directory

Create a directory for the plugin and a `.claude-plugin/` subdirectory inside it. Only `plugin.json` and `marketplace.json` belong in `.claude-plugin/`; everything else sits beside it.

```
my-plugin/
├── .claude-plugin/
│   ├── plugin.json          # required (only `name` is mandatory)
│   └── marketplace.json     # required for /plugin install to find it
├── hooks/hooks.json         # hook manifest (filename is fixed)
├── commands/hello.md        # one slash command per file
├── agents/                  # optional
├── skills/                  # optional
└── scripts/hook.mjs         # handler (any language; Node is convenient)
```

**`.claude-plugin/plugin.json`**

```json
{
  "name": "my-plugin",
  "description": "What this plugin does, in one sentence.",
  "version": "0.1.0"
}
```

**`.claude-plugin/marketplace.json`**

```json
{
  "name": "my-plugin-marketplace",
  "owner": { "name": "your-name" },
  "plugins": [
    { "name": "my-plugin", "source": "./" }
  ]
}
```

## 2. Add a slash command

Put one Markdown file per command under `commands/`. The frontmatter describes the command, the body becomes the prompt Claude runs, and `$ARGUMENTS` captures everything typed after the command name.

**`commands/hello.md`**

```markdown
---
description: Say hello and echo what the user passed in.
---

Greet the user warmly, then repeat back: $ARGUMENTS
```

## 3. Add a hook (optional)

Hooks register in `hooks/hooks.json` (filename is fixed). Each handler reads a JSON event from stdin and emits a JSON decision envelope on stdout. `PreToolUse` is the event that can block a tool call before it runs.

A few requirements apply to every hook. Reference handler files through `${CLAUDE_PLUGIN_ROOT}`, since plugins are copied to a versioned cache directory at install — relative paths won't resolve. Set a `timeout` so a hung script doesn't lock up the session. Resolve file paths against `event.cwd` rather than `process.cwd()`. The optional `if` field uses permission-rule syntax to pre-filter before spawning the handler, so you don't pay process-spawn cost on every tool call.

**`hooks/hooks.json`**

```json
{
  "description": "Block destructive Bash commands.",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**`scripts/hook.mjs`**

```javascript
#!/usr/bin/env node
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const event = JSON.parse(raw);
const command = event.tool_input?.command ?? "";

if (/\brm\s+-rf\s+\/(\s|$)/.test(command)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Blocked: `rm -rf /` is not allowed."
    }
  }));
}
// exit 0 with empty stdout = allow
```

For other events, matcher syntax, and the full decision envelope (`allow` / `deny` / `ask` / `defer`), see <https://code.claude.com/docs/en/hooks>.

## 4. Install the plugin

From a Claude Code session pointed at the parent directory, run two commands. No single-step shortcut exists.

```
/plugin marketplace add ./my-plugin
/plugin install my-plugin@my-plugin-marketplace
```

During development, pipe a fake event into the handler to exercise hook logic outside Claude:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"},"cwd":"/tmp"}' \
  | node scripts/hook.mjs
```

Isolate tests that touch `${CLAUDE_PLUGIN_DATA}` by running them under `HOME=$(mktemp -d) CLAUDE_PLUGIN_DATA=$(mktemp -d)` to avoid polluting real plugin data.

## 5. Use it

Slash commands are namespaced under the plugin name, so `commands/hello.md` becomes `/my-plugin:hello`:

```
> /my-plugin:hello Alex
```

To exercise the hook, ask Claude to run `rm -rf /` and watch the handler deny the call before Bash executes it.

## 6. Build yours

Pick the surface that fits your workflow, copy this scaffold, and replace the handler with your logic. Full reference at <https://code.claude.com/docs/en/plugins>.
