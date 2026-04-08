# `todo-registry` CLI binary

## Idea

A standalone `todo-registry` CLI (in `api-apps/` style) for browsing and searching the template registry.
Separate from `todoai` — this is read-only, no auth needed, uses the public `/cookie/v1/registry/` endpoints.

## Commands

```bash
todo-registry list                          # list all templates
todo-registry list --category seo           # filter by category
todo-registry search "keyword monitoring"   # fuzzy search by name/description
todo-registry show f5bot-monitoring-setup   # show template details + inputs
todo-registry categories                    # list all categories
```

## Implementation

- Bun + commander (same pattern as `api-apps/apollo-api`)
- Uses `ApiClient.listRegistryTemplates()` and `ApiClient.getRegistryTemplate()` from `@todoforai/edge`
- Or direct fetch to `/cookie/v1/registry/templates` (no auth needed)
- Lives in `api-apps/todo-registry-cli/` or as a subcommand of `todoai`

## Open question

Could also be `todoai registry list` / `todoai registry search` subcommands instead of a separate binary.
Separate binary is simpler (no coupling), subcommand is more discoverable.
