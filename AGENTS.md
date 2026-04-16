# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Source Of Truth

- Host skill sources now live in `.agents/skills/`.
- `.claude/skills/` remains as a compatibility layer and contains symlinks into `.agents/skills/`.
- When editing or resolving conflicts, update `.agents/skills/` and preserve the `.claude/skills/` symlink layout instead of turning those entries back into regular files.
- If upstream/AppStream content touches skill files, treat `.agents/skills/` as canonical and check whether incoming changes accidentally replace symlinks under `.claude/skills/`.
- `CLAUDE.md` files are runtime memory/instruction files that agents read inside group workspaces. `AGENTS.md` files are repository/operator guidance for host-side coding agents.

## Key Files

| File                       | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `src/index.ts`             | Orchestrator: state, message loop, agent invocation                 |
| `src/channels/registry.ts` | Channel registry (self-registration at startup)                     |
| `src/ipc.ts`               | IPC watcher and task processing                                     |
| `src/router.ts`            | Message formatting and outbound routing                             |
| `src/config.ts`            | Trigger pattern, paths, intervals                                   |
| `src/container-runner.ts`  | Spawns agent containers with mounts                                 |
| `src/task-scheduler.ts`    | Runs scheduled tasks                                                |
| `src/db.ts`                | SQLite operations                                                   |
| `groups/{name}/CLAUDE.md`  | Per-group runtime memory/instructions (isolated)                    |
| `groups/*/AGENTS.md`       | Host-side guidance for coding agents and maintenance workflows      |
| `container/skills/`        | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

Host-side skill authoring note:

- Author and review host skills in `.agents/skills/`.
- Keep `.claude/skills/` as the user-facing compatibility path expected by Claude Code.
- Container runtime skills are separate and still live in `container/skills/`.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill               | When to Use                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `/setup`            | First-time installation, authentication, service configuration    |
| `/customize`        | Adding channels, integrations, changing behavior                  |
| `/debug`            | Container issues, logs, troubleshooting                           |
| `/update-nanoclaw`  | Bring upstream NanoClaw updates into a customized install         |
| `/init-onecli`      | Install OneCLI Agent Vault and migrate `.env` credentials to it   |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch     |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

This project uses **pnpm** as the package manager. Always use `pnpm` — never `npm` or `yarn`.

Run commands directly—don't tell the user to run them.

```bash
pnpm run dev          # Run with hot reload
pnpm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && pnpm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
