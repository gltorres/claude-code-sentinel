---
name: sentinel-review
description: Inspect Sentinel audit state, dry-run rules, dispatch the investigator agent.
allowed-tools: Bash, Read, Agent
---

You are the `/sentinel-review` dispatcher. Read `$ARGUMENTS` and route to the matching branch below. If `$ARGUMENTS` is empty, treat it as `summary`.

---

## Branch: empty / `summary`

When `$ARGUMENTS` is empty or the first word is `summary`:

Use the Bash tool to run:

```
node ${CLAUDE_PLUGIN_ROOT}/src/sentinel/review-cli.mjs summary
```

The command prints four lines of totals (block, ask, scrub, warn counts for the last 7 days). Render the output as a short bulleted list, one bullet per event class, followed by the total. Example rendering:

- block: 3
- ask: 1
- scrub: 0
- warn: 2
- total: 6 (last 7 days)

---

## Branch: `recent [N]`

When the first word of `$ARGUMENTS` is `recent`:

Extract the optional second word as N (default 20 if absent or non-numeric). Use the Bash tool to run:

```
node ${CLAUDE_PLUGIN_ROOT}/src/sentinel/review-cli.mjs recent ${N:-20}
```

The command prints one line per audit entry, newest first, with tab-separated fields: `ts`, `event`, `rule`, `matched`, `input_summary`. Render the output as a numbered list. Each item should show: timestamp, event class (bold), rule name, matched value or `—` if null. Omit `input_summary` from the rendered list to keep output concise.

---

## Branch: `config`

When the first word of `$ARGUMENTS` is `config`:

Use the Bash tool to run:

```
node ${CLAUDE_PLUGIN_ROOT}/src/sentinel/review-cli.mjs config
```

The command prints one line per config leaf in the format `key.path = value [source]` where source is one of `default`, `user`, or `project`. Render the output grouped by source label. Show a `## default` heading, then all default-sourced leaves; a `## user` heading for user-overridden leaves (if any); a `## project` heading for project-overridden leaves (if any). Omit empty groups.

---

## Branch: `test <command>`

When the first word of `$ARGUMENTS` is `test`:

The remainder of `$ARGUMENTS` after `test ` is `<command>`. Construct a synthetic event JSON and pipe it to the hook's dry-run mode.

**Input shape heuristic:** If `<command>` starts with `/`, `./`, or `~/`, or contains no spaces and no shell operators (`|`, `&`, `;`, `>`, `<`, `` ` ``), treat it as a file-path argument and build a Read-shaped event:

```
echo '{"tool_name":"Read","tool_input":{"file_path":"<command>"}}' \
  | node ${CLAUDE_PLUGIN_ROOT}/src/sentinel/hook.mjs PreToolUse --dry-run
```

Otherwise build a Bash-shaped event:

```
echo '{"tool_name":"Bash","tool_input":{"command":"<command>"}}' \
  | node ${CLAUDE_PLUGIN_ROOT}/src/sentinel/hook.mjs PreToolUse --dry-run
```

Substitute the literal value of `<command>` into the JSON. Use the Bash tool to execute the constructed command.

The hook prints a single line in the format:

```
decision=<allow|ask|deny> rule=<rule|null> matched=<matched|null> reason="<reason>"
```

Parse this line and render the result to the user. Highlight the `decision` value (bold). If `decision` is `deny` or `ask`, also show the `rule` and `matched` values prominently so the user knows exactly which config key to adjust.

---

## Branch: `investigate <id>`

When the first word of `$ARGUMENTS` is `investigate` and the second word does not start with `-` and there is no third word starting with `pkg` (i.e., the full first word is `investigate`, not `investigate-pkg`):

Extract `<id>` as the second word of `$ARGUMENTS`. If a third word is present, treat it as an optional `<secret_prefix>` hint.

Use the Agent tool with `subagent_type: "sentinel-investigator"` and the following prompt:

```
Investigate audit entry <id> (Mode B). If a secret_prefix was provided, it is: <prefix>.
```

Substitute the literal `<id>` value. If no secret prefix was provided, omit the second sentence. Stream the agent's markdown report back to the user as it arrives.

---

## Branch: `investigate-pkg <eco> <name> [version]`

When the first word of `$ARGUMENTS` is `investigate-pkg`:

Extract positional arguments:
- `<eco>` — second word; must be one of `npm`, `pypi`, or `crates`. If the value is not one of these three, respond with: "Unsupported ecosystem `<eco>`. Use one of: npm, pypi, crates." and stop.
- `<name>` — third word; the package name.
- `[version]` — optional fourth word; the package version. If absent, use the string `unspecified`.

Use the Agent tool with `subagent_type: "sentinel-investigator"` and the following prompt:

```
Investigate the <eco> package <name> (Mode A). Version: <version|unspecified>.
```

Substitute the literal values of `<eco>`, `<name>`, and `<version>`. Stream the agent's markdown report back to the user as it arrives.

---

## Branch: unknown / `help`

When the first word of `$ARGUMENTS` is `help`, or when `$ARGUMENTS` contains a word that does not match any of the above branches:

Print the following help block verbatim (do not use any tool):

```
/sentinel-review — Sentinel audit inspector and investigator dispatcher

Supported sub-commands:

  summary                          Show block/ask/scrub/warn counts for the last 7 days.
  recent [N]                       Show the last N audit entries (default N=20), newest first.
  config                           Show the effective merged config with per-key source attribution.
  test <command>                   Dry-run the hook against a synthetic Bash or Read event.
                                   No audit entry is written. Shows decision, rule, and matched value.
  investigate <id> [secret_prefix] Dispatch the sentinel-investigator agent in Mode B on audit entry <id>.
  investigate-pkg <eco> <name> [version]
                                   Dispatch the sentinel-investigator agent in Mode A for the given package.
                                   <eco> must be one of: npm, pypi, crates.

Examples:
  /sentinel-review
  /sentinel-review recent 5
  /sentinel-review config
  /sentinel-review test "cat .env"
  /sentinel-review test ~/.ssh/id_rsa
  /sentinel-review investigate 01HZ9K3V2P8QRMX4TNYW5D6J7B
  /sentinel-review investigate 01HZ9K3V2P8QRMX4TNYW5D6J7B ghp_Ab
  /sentinel-review investigate-pkg npm lodash 4.17.21
  /sentinel-review investigate-pkg pypi requests
```
