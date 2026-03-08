# RBXMCP v1.7 Protocol

## Overview
- Bridge transport (Studio plugin <-> server): HTTP JSON on `127.0.0.1:<RBXMCP_PORT>` (default `5100`), base `/v1/studio`.
- Agent facade transport (AI/chat clients <-> server): HTTP JSON on `/v1/agent`.
- Session model: **one active Studio session per server process** (`1 port = 1 project = 1 session`).
- Supported script classes: `Script`, `LocalScript`, `ModuleScript`.
- Supported UI roots: `LayerCollector` trees (`ScreenGui`, `SurfaceGui`, `BillboardGui`, etc).
- UI API is strict UI-only: non-UI classes such as `Folder`, `Model`, and other non-UI containers are not valid UI nodes for read/write APIs.
- Write mode: strict draft workflow with hash-locked updates.

## Environment Controls
- `RBXMCP_PORT` (default `5100`)
- `RBXMCP_HOST` (default `127.0.0.1`)
- `RBXMCP_PROJECT_ALIAS` (optional display alias in health/capabilities)
- `RBXMCP_EXPECT_PLACE_ID` (optional hard guard at `/v1/studio/hello`)
- `RBXMCP_READ_MAX_AGE_MS` (default `5000`)
- `RBXMCP_ENABLE_ADMIN_MUTATIONS` (default `false`; gates `/v1/admin/upsert_script`)

## Studio Bridge Endpoints
### `POST /v1/studio/hello`
Registers/refreshes plugin session.

Request:
```json
{
  "clientId": "plugin-guid",
  "placeId": "123456",
  "placeName": "MyPlace",
  "pluginVersion": "0.1.8",
  "editorApiAvailable": true,
  "base64Transport": true,
  "logCaptureAvailable": true
}
```

### `POST /v1/studio/poll`
Long-poll for one command.

### `POST /v1/studio/result`
Completes command with `ok/result` or `ok=false/error`.

### `POST /v1/studio/push_snapshot`
Pushes `mode=all|partial` snapshots into cache/index.
- Optional field `hash` is accepted per script.
- When provided, this hash is used as CAS hash for subsequent `update_script` calls (keeps server/plugin hash contract aligned).

### `POST /v1/studio/push_ui_snapshot`
Pushes `mode=all|partial` UI root snapshots into UI cache/index.

### `POST /v1/studio/push_logs`
Pushes incremental runtime logs captured in Studio/plugin.

## Agent Facade Endpoints
### `GET /v1/agent/capabilities`
Returns machine-friendly server descriptor:
- `projectAlias`, `bridge`, active project (`placeId/placeName`), write policy, defaults, operation list.
- Includes `contracts` section with canonical payload keys (for example `update_script` requires `path`, `newSource`, `expectedHash`).
- Includes bootstrap metadata:
  - `preferredBootstrapCalls`
  - `bootstrapWorkflow`
  - `recommendedNextStepByError`

### `POST /v1/agent/health`
Returns same health payload as `/healthz`.

### `POST /v1/agent/list_scripts`
Input:
```json
{ "service": "StarterGui", "query": "shop", "limit": 20 }
```
Output includes `items`, `cacheUpdatedAt`, `cacheAgeMs`.

### `POST /v1/agent/get_script`
Input:
```json
{
  "path": ["ServerScriptService", "Main"],
  "forceRefresh": false,
  "maxAgeMs": 5000
}
```
Output:
```json
{
  "ok": true,
  "path": ["ServerScriptService", "Main"],
  "source": "print('x')",
  "hash": "abcd1234",
  "updatedAt": "2026-03-05T12:00:00.000Z",
  "draftAware": true,
  "readChannel": "editor",
  "fromCache": true,
  "cacheAgeMs": 1200,
  "refreshedBeforeRead": false
}
```

### `POST /v1/agent/refresh_script`
Forces targeted pull from Studio.

### `POST /v1/agent/update_script`
Hash-locked update only.

Input:
```json
{
  "path": ["ServerScriptService", "Main"],
  "newSource": "print('new')",
  "expectedHash": "abcd1234",
  "placeId": "123456"
}
```

### `POST /v1/agent/create_script`
Create-only API (no overwrite).

Input:
```json
{
  "path": ["StarterGui", "MyLocal"],
  "className": "LocalScript",
  "source": "print('created')",
  "placeId": "123456"
}
```

If path already exists: `409 already_exists`.

### `POST /v1/agent/delete_script`
Hash-locked delete only.

### `POST /v1/agent/move_script`
Hash-locked move/rename only.
- `newParentPath` must already exist.
- Rename is modeled as move to the same parent with `newName`.

### UI endpoints (agent)
- `POST /v1/agent/list_ui_roots`
- `POST /v1/agent/get_ui_tree`
- `POST /v1/agent/get_ui_layout_snapshot`
- `POST /v1/agent/validate_ui_layout`
- `POST /v1/agent/search_ui`
- `POST /v1/agent/apply_ui_batch`
- `POST /v1/agent/clone_ui_subtree`
- `POST /v1/agent/apply_ui_template`
- `POST /v1/agent/update_ui`
- `POST /v1/agent/create_ui`
- `POST /v1/agent/delete_ui`
- `POST /v1/agent/move_ui`

UI writes are version-locked.
- Preferred workflow for large UI authoring: `get_ui_tree(forceRefresh=true) -> apply_ui_batch(expectedVersion)`.

### Log endpoints (agent)
- `POST /v1/agent/get_logs`

### Retrieval endpoints (agent)
- `POST /v1/agent/get_project_summary`
- `POST /v1/agent/get_related_context`
- `POST /v1/agent/get_ui_summary`
- `POST /v1/agent/explain_error`
- `POST /v1/agent/validate_operation`
- `POST /v1/agent/apply_script_patch`
- `POST /v1/agent/diff_script`
- `POST /v1/agent/find_entrypoints`
- `POST /v1/agent/find_remotes`
- `POST /v1/agent/rank_files_by_relevance`
- `POST /v1/agent/get_changed_since`
- `POST /v1/agent/get_symbol_context`
- `POST /v1/agent/search_text`
- `POST /v1/agent/find_symbols`
- `POST /v1/agent/find_references`
- `POST /v1/agent/get_context_bundle`
- `POST /v1/agent/get_script_range`
- `POST /v1/agent/get_dependencies`
- `POST /v1/agent/get_impact`
- `POST /v1/agent/refresh_scripts`
- `POST /v1/agent/find_ui_bindings`

Unknown endpoint behavior:
- Returns `404 endpoint_not_found` with a hint to call `/v1/agent/capabilities` first.

## Bootstrap / Retrieval Guidance
- Preferred empty-chat bootstrap:
  - `GET /v1/agent/capabilities`
  - `POST /v1/agent/health`
  - `POST /v1/agent/get_project_summary`
- `get_project_summary` is cache-first and only triggers initial script/UI snapshots when the relevant cache is empty.
- `find_entrypoints` returns statically inferred startup/controller candidates:
  - `server_bootstrap`
  - `client_bootstrap`
  - `ui_controller`
  - `remote_handler`
  - `high_fan_in_module`
- `find_remotes` is heuristic and static. If a full remote path cannot be proven from source, it returns `inferredPath = null`.
- `find_remotes` v2 adds:
  - `confidence`
  - `evidence[]`
  - `argHints[]`
  - `pairedParticipants[]`
  - `unresolvedPath`
- `rank_files_by_relevance` combines text, symbol, dependency, UI, and remote evidence into one ranked file list.
- `get_changed_since` accepts either:
  - monotonic journal cursor string
  - ISO timestamp
- `get_symbol_context` is the specialized symbol-debug flow:
  - definition
  - bounded references
  - one-hop dependency neighborhood
  - compact context chunks
- `get_related_context` requires exactly one of:
  - `target.path`
  - `target.symbol`
  - `target.query`
- `get_ui_summary` returns a compact subtree summary:
  - class histogram
  - interactive nodes
  - text-bearing nodes
  - layout primitives
  - heuristic `bindingHints`
- `get_ui_layout_snapshot` returns edit-time geometry metadata for UI nodes:
  - `anchorPoint`
  - `position`
  - `size`
  - `absolutePosition`
  - `absoluteSize`
  - `zIndex`
  - `clipsDescendants`
  - text-like fields when available
- `validate_ui_layout` returns machine-friendly issues:
  - `zero_size`
  - `offscreen`
  - `overlap`
  - `clipped_by_parent`
  - `hidden_interactive`
  - `text_overflow_risk`
  - `layout_conflict`
  - `partial_geometry_only`
- Layout diagnostics are edit-time only. No screenshot capture and no runtime/play validation are part of this protocol.
- `explain_error` is the canonical recovery helper for API failures and does not modify the base error envelope.
- `validate_operation` is the canonical dry-run for high-level authoring flows:
  - `script_patch`
  - `script_delete`
  - `script_move`
  - `ui_layout`
  - `ui_clone`
  - `ui_template`
  - `ui_batch`
- `apply_script_patch` uses structured operations, not unified diff text:
  - `replace_range`
  - `replace_text`
  - `insert_after_line`
  - `delete_range`
- `diff_script` compares current source against:
  - explicit `baseHash`, or
  - previous retained script history version
- `clone_ui_subtree` compiles cached UI subtree snapshots into one version-locked batch mutation under one `rootPath`.
- `apply_ui_template` supports:
  - `modal`
  - `shop_grid`
- `apply_ui_batch` supports ergonomic intra-batch refs:
  - `create_node.id`
  - `create_node.parentRef`
  - `update_props.pathRef`
  - `delete_node.pathRef`
  - `move_node.pathRef`
  - `move_node.newParentRef`
- Preferred project navigation flow:
  - `get_project_summary(verbosity=minimal) -> find_entrypoints(verbosity=minimal) -> rank_files_by_relevance(verbosity=minimal)`
- Preferred symbol debugging flow:
  - `get_symbol_context(verbosity=minimal) -> get_related_context(path, verbosity=minimal)`
- Preferred script patch review flow:
  - `validate_operation(script_patch) -> apply_script_patch -> diff_script`
- Preferred script tree edit flow:
  - `get_script(forceRefresh=true) -> validate_operation(script_move|script_delete) -> move_script/delete_script`
- Preferred layout diagnostics flow:
  - `get_ui_layout_snapshot(forceRefresh=true) -> validate_ui_layout(forceRefresh=true)`
- Preferred UI clone flow:
  - `get_ui_tree(forceRefresh=true) -> validate_operation(ui_clone) -> clone_ui_subtree`
- Preferred UI template flow:
  - `get_ui_tree(forceRefresh=true) -> validate_operation(ui_template) -> apply_ui_template`
- Preferred UI binding discovery flow:
  - `find_ui_bindings(target={uiPath|scriptPath|query})`
- `verbosity` is additive on compact retrieval endpoints:
  - `minimal`
  - `normal`
- `minimal` is recommended for bootstrap/navigation to reduce token cost.

## Command Types (plugin poll queue)
- `snapshot_all_scripts`
- `snapshot_script_by_path`
- `snapshot_scripts_by_paths` (fallback to single-path snapshots on `unsupported_command`)
- `set_script_source_if_hash`
- `delete_script_if_hash`
- `move_script_if_hash`
- `upsert_script`
- `snapshot_ui_roots`
- `snapshot_ui_subtree_by_path`
- `snapshot_ui_layout_by_path`
- `mutate_ui_batch_if_version`

## Write Safety Rules
- `update_script`: always `refresh -> compare expectedHash -> write -> refresh`.
- If hash mismatches: `409 hash_conflict`, no write.
- `create_script` checks existence via targeted refresh before create.
- `delete_script`: always `refresh -> compare expectedHash -> delete -> verify missing`.
- `move_script`: always `refresh -> compare expectedHash -> move -> refresh new path`.
- `/v1/admin/upsert_script` is disabled unless `RBXMCP_ENABLE_ADMIN_MUTATIONS=true`.

## Freshness Rules
- Default read freshness for `get_script`/`get_script_range`: `maxAgeMs=5000`, `forceRefresh=false`.
- Default read freshness for `get_ui_tree`: `maxAgeMs=5000`, `forceRefresh=false`.
- If `forceRefresh=true` or cache age exceeds `maxAgeMs`, server performs targeted refresh first.
- Read responses include `fromCache`, `cacheAgeMs`, `refreshedBeforeRead`.
- Cache-first endpoints (`list/search/symbols/references/context`) include `cacheUpdatedAt` and `cacheAgeMs`.

## Multi-project Guardrails
- Optional `RBXMCP_EXPECT_PLACE_ID` rejects mismatched `/hello` with `project_mismatch`.
- Mutating operations accept optional `placeId`; mismatch with active project returns `project_mismatch`.

## Command Timeouts
- `snapshot_all_scripts`: `90000 ms`
- `snapshot_script_by_path`: `30000 ms`
- `snapshot_scripts_by_paths`: `60000 ms`
- `set_script_source_if_hash`: `45000 ms`
- `upsert_script`: `45000 ms`
- `snapshot_ui_roots`: `90000 ms`
- `snapshot_ui_subtree_by_path`: `30000 ms`
- `mutate_ui_batch_if_version`: `45000 ms`
- default fallback: `15000 ms`

## Error Envelope
```json
{
  "ok": false,
  "error": {
    "code": "hash_conflict",
    "message": "Hash mismatch before write",
    "details": {}
  }
}
```

Common codes: `project_mismatch`, `already_exists`, `hash_conflict`, `version_conflict`, `play_mutation_forbidden`, `studio_offline`, `unsupported_command`, `admin_mutations_disabled`, `invalid_source_base64`, `plugin_internal_error`, `ui_class_not_supported`, `path_blocked_by_non_ui_child`, `name_occupied_by_non_ui_child`, `batch_operation_failed`.

Iteration 3 authoring codes:
- `patch_invalid`
- `patch_target_not_found`
- `base_not_available`
- `template_invalid`
- `invalid_operation_kind`
- `ui_operation_out_of_root`

Iteration 7 mutation/diagnostic codes:
- `script_parent_not_found`
- `path_occupied_by_non_script_child`
- `delete_verification_failed`
- `invalid_ui_operation`

UI-specific semantics:
- `ui_class_not_supported`: class is not UI-relevant (`Folder`/`Model`/etc are rejected).
- `path_blocked_by_non_ui_child`: requested UI path resolves to a non-UI child, so traversal is blocked.
- `name_occupied_by_non_ui_child`: create target name is already taken by a non-UI sibling.
- `batch_operation_failed`: batch mutation failed; details include `operationIndex` and offending operation.
- `invalid_ui_operation`: invalid or unresolved batch ref usage (`id/pathRef/parentRef/newParentRef`).
- `script_parent_not_found`: `move_script` target parent does not exist.
- `path_occupied_by_non_script_child`: a non-script instance already occupies the target script path.
- Recovery guidance for common codes is available through `POST /v1/agent/explain_error`.

