# multi-sessions

A Claude Code mod for people who run several sessions at once. It draws a band
above the prompt, in every session, listing all your running sessions:

- what each one is working on, and its plan progress (`3/7 · Wire the API`)
- what it needs from you: a permission to approve, a question it asked, or a
  reply it is waiting on, and for how long
- sessions that compete with each other: the same files edited in the last
  hour, what looks like the same task, or two sessions editing the same
  checkout at once

Buttons on the band: **Open** jumps to a session (Claude desktop app),
**Pause other** messages the other session to stop and ask you how to split
the work, **Dismiss** hides a clash, **Hide/Show** folds the band.
**Done for now** puts a session away from every band until you prompt it
again or it stops on a permission or question; the header's
**n done for now** lists those sessions, each with **Bring back**. A toast
appears when another session starts needing you or a new clash shows up.

The band shares its slot: any other mod's band above the prompt is drawn
first, above this one.

The band appears once two or more sessions run the mod.

## Install

At the prompt of a terminal session:

```
/plugin install multi-sessions --marketplace MJ772/multi-sessions
```

From a shell:

```
claude plugin install multi-sessions --marketplace MJ772/multi-sessions
```

In the desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with `MJ772/multi-sessions`,
then **Add plugin**.

Install it at the user scope so every session loads it: each session publishes
its own state, so a session without the mod does not show up. Sessions that
were already open pick it up when they restart.

Needs a Claude Code build with mods (function hooks); built and tested on
2.1.308, an early-access API that may change between releases. The band draws
in the desktop app and the terminal.

## What it reads and writes

Everything stays on your machine. The mod makes no network requests.

- It writes one small JSON file per session to `~/.claude/multi-sessions/`
  (or `$CLAUDE_CONFIG_DIR/multi-sessions/`): the session's folder, its latest
  prompt and first prompt (each cut to 300 characters), its plan items, the
  paths of files it edited in the last hour, what it is waiting on, and the
  closing summary of its last turn. Every session on the machine reads those
  files to draw the band. The files are not deleted; the band ignores any
  older than 12 hours.
- **Done for now** keeps the sessions put away, each with the time it was
  put away, in `_parked.txt` in the same folder, so every band hides them.
- In the desktop app it reads the session's own title from the app's session
  file (under `%APPDATA%\Claude\claude-code-sessions\` on Windows,
  `~/Library/Application Support/Claude/claude-code-sessions/` on macOS).
- **Open** runs `explorer.exe` (Windows) or `open` (macOS) with a
  `claude://claude.ai/epitaxy/<session id>` link.
- **Pause other** sends a plain-text message to the other session through
  Claude Code's own session messaging.

## Known limits

- After you approve a long-running command, its session shows "needs
  approval" until the command finishes: Claude Code reports no event when the
  approval is given.
- A session whose process restarted (the desktop app re-waking it) publishes
  again from its next prompt; one that was waiting on you stays listed,
  marked asleep.
- Routine files every session edits are not counted as clashes: a notes
  vault's `wiki/index.md`, `log.md`, `hot.md`, `pending.md`,
  `skills-usage.md`, `skills-insights.md`, and a project's auto memory under
  `.claude/projects/*/memory/`. Edit `ROUTINE` in `hooks/logic.ts` to change
  that list.

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

MIT
