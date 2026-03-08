# RBXMCP

Roblox MCP v1.7:
- Node.js/TypeScript MCP server over STDIO
- Local Studio bridge API on `127.0.0.1:5100` (or `RBXMCP_PORT`)
- Agent HTTP facade (`/v1/agent/*`) for chats started outside this repo
- Minimal Roblox Studio plugin (`plugin/Plugin.main.lua`)
- Disk cache in `.rbxmcp/cache/<placeId>`
- Strict draft-first writes (`draft_only`, no direct `script.Source` fallback)
- Hash-locked updates + create-only script creation (no overwrite by default)
- Core MCP tools:
  - `rbx_health`
  - `rbx_list_scripts`
  - `rbx_get_script` (`forceRefresh`, `maxAgeMs`)
  - `rbx_refresh_script`
  - `rbx_update_script`
  - `rbx_create_script`
  - `rbx_delete_script`
  - `rbx_move_script`
- Retrieval/index tools for large projects:
  - `rbx_get_project_summary`
  - `rbx_get_related_context`
  - `rbx_get_ui_summary`
  - `rbx_explain_error`
  - `rbx_validate_operation`
  - `rbx_apply_script_patch`
  - `rbx_diff_script`
  - `rbx_find_entrypoints`
  - `rbx_find_remotes`
  - `rbx_rank_files_by_relevance`
  - `rbx_get_changed_since`
  - `rbx_get_symbol_context`
  - `rbx_search_text`
  - `rbx_find_symbols`
  - `rbx_find_references`
  - `rbx_get_context_bundle`
  - `rbx_get_script_range`
  - `rbx_get_dependencies`
  - `rbx_get_impact`
  - `rbx_refresh_scripts`
  - `rbx_find_ui_bindings`
- UI tools:
  - `rbx_list_ui_roots`
  - `rbx_get_ui_tree`
  - `rbx_get_ui_layout_snapshot`
  - `rbx_validate_ui_layout`
  - `rbx_get_ui_summary`
  - `rbx_search_ui`
  - `rbx_apply_ui_batch`
  - `rbx_clone_ui_subtree`
  - `rbx_apply_ui_template`
  - `rbx_update_ui`
  - `rbx_create_ui`
  - `rbx_delete_ui`
  - `rbx_move_ui`
- Log tools:
  - `rbx_get_logs`
- Server code lives in `server/src`.

## Run
```bash
npm.cmd install
npm.cmd run dev
```

Custom bridge port (PowerShell):
```powershell
$env:RBXMCP_PORT="5100"
npm.cmd run dev
```

Optional env:
```powershell
$env:RBXMCP_PROJECT_ALIAS="Arena-A"
$env:RBXMCP_EXPECT_PLACE_ID="123456789"
$env:RBXMCP_READ_MAX_AGE_MS="5000"
$env:RBXMCP_ENABLE_ADMIN_MUTATIONS="true" # only if you really need /v1/admin/upsert_script
```

## Build
```bash
npm.cmd run build
```

## Test
```bash
npm.cmd test
```

## Studio Setup
1. Create/install a plugin and paste [`plugin/Plugin.main.lua`](/C:/Users/vidin/Desktop/RBXMCP/plugin/Plugin.main.lua).
2. Enable HTTP requests in Roblox Studio settings.
3. Start MCP server (`npm.cmd run dev`).
4. The plugin starts `OFF` by default on every Studio launch. Enable it manually in the dock panel when you want the bridge active.
5. Port/host/scheme are remembered per `placeId`, so different projects can keep different bridge ports without leaking settings across projects.

## Multi-project workflow
- Rule: `1 port = 1 project = 1 Studio session`.
- Run one RBXMCP process per project (different `RBXMCP_PORT` per process).
- In each Studio window set matching plugin URL: `http://127.0.0.1:<port>/v1/studio`.
- The plugin remembers port/host/scheme per `placeId`, but bridge enabled state is session-only and always starts OFF.
- For strict binding use `RBXMCP_EXPECT_PLACE_ID`.

## New chat bootstrap (empty folder)
1. Call `GET http://127.0.0.1:<port>/v1/agent/capabilities`.
   - Use `contracts.*` fields exactly.
2. Then call:
   - `POST /v1/agent/health`
   - `POST /v1/agent/get_project_summary`
3. After bootstrap, pick the narrowest follow-up:
   - `POST /v1/agent/get_related_context` when you already know a path, symbol, or search term
   - `POST /v1/agent/get_ui_summary` when you know the UI subtree path
   - `POST /v1/agent/explain_error` when an API call fails
4. For edits always pass fresh `expectedHash` or `expectedVersion` from the latest read/refresh.

## AI workflows
- Bootstrap:
  - `capabilities -> health -> get_project_summary(verbosity=minimal) -> targeted retrieval`
- Project navigation:
  - `get_project_summary(verbosity=minimal) -> find_entrypoints(verbosity=minimal) -> rank_files_by_relevance(verbosity=minimal)`
- Symbol debug:
  - `get_symbol_context(verbosity=minimal) -> get_related_context(path, verbosity=minimal)`
- Script patch review:
  - `validate_operation(script_patch) -> apply_script_patch -> diff_script`
- Script tree edit:
  - `get_script(forceRefresh=true) -> validate_operation(script_move|script_delete) -> move_script/delete_script`
- Script edit:
  - `search_text -> get_script(forceRefresh=true) -> update_script(expectedHash)`
- Related context:
  - `get_related_context(target={path|symbol|query}, verbosity=minimal|normal)`
- UI edit:
  - `search_ui -> get_ui_tree(forceRefresh=true) -> apply_ui_batch(expectedVersion)`
  - `search_ui -> get_ui_tree(forceRefresh=true) -> update_ui(expectedVersion)`
- Layout diagnostics:
  - `get_ui_layout_snapshot(path, forceRefresh=true) -> validate_ui_layout(path, forceRefresh=true)`
- UI clone:
  - `get_ui_tree(forceRefresh=true) -> validate_operation(ui_clone) -> clone_ui_subtree`
- UI template:
  - `get_ui_tree(forceRefresh=true) -> validate_operation(ui_template) -> apply_ui_template`
- UI inspection:
  - `get_ui_summary(path)`
- UI binding discovery:
  - `find_ui_bindings(target={uiPath|scriptPath|query})`
- Log inspection:
  - `get_logs(cursor)`
- Error recovery:
  - `explain_error(code, details?)`

## Notes
- Layout diagnostics are edit-time only. There is no screenshot capture and no runtime/play validation in the current wave.
- `find_ui_bindings` returns heuristic hints with confidence, not guaranteed controller truth.
- Remote graph is static/heuristic v2. When the exact path cannot be proven, `inferredPath` stays `null`.
- `apply_ui_batch` supports intra-batch refs (`id`, `pathRef`, `parentRef`, `newParentRef`) so large UI payloads do not need to repeat absolute paths.

