# CLAUDE.md

Read `AGENTS.md` for project instructions (architecture, build, patterns, gotchas).

## Preferences

- Use `npm` for this project (TypeScript/Node.js, not Python)
- Reference `status-app-agent` project for status-backend integration patterns

## Knowledge Base

**Vault**: `$OBSIDIAN_VAULT_PATH` — read `PROJECTS_REGISTRY.yaml` in vault root for paths, notes, and cross-project navigation.

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available skills: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/review`, `/ship`, `/browse`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/retro`, `/debug`, `/document-release`.
