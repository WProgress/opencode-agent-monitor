# OpenCode Agent Monitor TUI

An OpenCode terminal UI plugin that adds a "Working agents" panel to the sidebar, showing the agents currently working in the session family.

## Install

```powershell
opencode plugin add @wiseprogress/opencode-agent-monitor-tui
```

OpenCode installs the package through its own npm cache and records it in `cli.json`, the TUI plugin list. Because this is a TUI-only package, the command does not edit `opencode.json`.

Restart OpenCode if the sidebar does not appear.

Verify that OpenCode sees the plugin:

```powershell
opencode plugin list
```

## Requirements

- OpenCode 2.2.5, the version this plugin was built and installed against.
- A terminal UI with sidebars.
- No Node.js version to manage. OpenCode's bundled runtime loads the plugin source directly; there is no build step.
- TUI only: the package has no server component.
- No network access, no database access, and no separate service to run.

## Manual configuration

`opencode plugin add` writes the entry for you. To add it by hand, edit `cli.json` in the global OpenCode config directory: `~/.config/opencode/cli.json` on Linux and macOS, or `C:\Users\<you>\.config\opencode\cli.json` on Windows.

Use `cli.json`, not `opencode.json`, because this package only extends the terminal UI.

Bare entry:

```json
{
  "plugins": ["@wiseprogress/opencode-agent-monitor-tui"]
}
```

Entry with options:

```json
{
  "plugins": [
    {
      "package": "@wiseprogress/opencode-agent-monitor-tui",
      "options": { "maxRows": 12, "showModel": false }
    }
  ]
}
```

## Options

| Option | Type | Default | Behavior |
|---|---|---|---|
| `scope` | string | `"session"` | Which agents to show. Only `"session"` is supported and respected: the current session family. |
| `showCoordinator` | boolean | `true` | Show the coordinator row when space allows: `maxRows` must be greater than the number of running sub-agents. |
| `showModel` | boolean | `true` | Show the model name on the task line. |
| `maxRows` | integer | `8` | Maximum agent rows to display. Running sub-agents keep priority; rows that do not fit are reported as `+N more`. Valid range: 1 to 20. |

Unknown or invalid values fall back to the defaults: a `maxRows` that is not an integer or is outside 1–20 becomes `8`, a `scope` other than `"session"` is treated as `"session"`, and non-boolean values for `showCoordinator` and `showModel` use their defaults.

## What the panel shows

For each running agent in the current session family:

- Agent name and elapsed time on the first line.
- Model name and the session or task title on the second line.
- Indentation for sub-agents, so reports sit below the coordinator that delegated to them.

When nothing is running, the panel shows `No agents working`. Colors follow the active terminal theme.

Illustrative layout (not a screenshot), with the default `maxRows` of 8:

```text
Working agents
~ ceo  2m 10s
  Claude Opus 4.5 - coordinating - Ship the release
  > build  1m 05s
    Claude Sonnet 4.5 - Fix plugin packaging
  > review  0m 42s
    Claude Sonnet 4.5 - Review README
```

`~ ceo` is the coordinator; the indented `> build` and `> review` rows are its running sub-agents. The coordinator row appears only when `maxRows` is greater than the number of running sub-agents, so running agents keep priority when space is tight. When rows do not fit, the panel ends with `+N more`. Exact spacing and truncation depend on terminal width and theme.

## Limitations

- Current session only. This is not a cross-project dashboard. For a full local dashboard, use the main package, [`@wiseprogress/opencode-agent-monitor`](https://www.npmjs.com/package/@wiseprogress/opencode-agent-monitor).
- Read-only. The panel observes sessions; it never starts, stops, or messages an agent.
- No configuration UI. Options are edited in `cli.json`.

## Uninstall

```powershell
opencode plugin remove @wiseprogress/opencode-agent-monitor-tui
```

## License

MIT © 2026 wiseprogress.

Unofficial community project, not affiliated with or endorsed by the OpenCode project.
