# Chat History

This folder stores readable transcripts of Claude Code sessions run against this
repository. Unlike the rest of the project root, it is **not** covered by the
blanket `/*` rule in [`../.gitignore`](../.gitignore) — see the
`!/chat-history/` exception there — so files placed here are tracked by git and
pushed to GitHub along with the rest of the project.

## Layout

Each session gets its own Markdown file, named:

```
chat-history/YYYY-MM-DD-<short-slug>.md
```

A file contains, in order:

- the user's message(s) for that turn, verbatim
- a short note on what Claude did (files touched, commands run)
- Claude's final reply to the user

Tool-call noise (raw tool_use/tool_result payloads, repeated system reminders,
etc.) is intentionally left out — the goal is a human-readable record of what
was asked and what changed, not a raw transcript dump.

## Getting the raw transcript

If you ever need the full raw transcript (including every tool call) for a
session, it's not generated automatically into this folder. Ask Claude to
export it — it will save a zip locally (outside the repo, in Downloads) that
you can inspect or selectively copy from.
