export interface ErrorGuidance {
  code: string;
  meaning: string;
  likelyCauses: string[];
  retryable: boolean;
  recommendedNextCall: {
    tool?: string;
    endpoint?: string;
    payloadTemplate?: Record<string, unknown>;
  } | null;
  notes: string[];
}

function guidance(
  code: string,
  meaning: string,
  likelyCauses: string[],
  retryable: boolean,
  recommendedNextCall: ErrorGuidance["recommendedNextCall"],
  notes: string[] = []
): ErrorGuidance {
  return {
    code,
    meaning,
    likelyCauses,
    retryable,
    recommendedNextCall,
    notes
  };
}

export function explainBridgeError(codeInput: string, details?: unknown): ErrorGuidance {
  const code = String(codeInput ?? "").trim() || "unknown_error";

  switch (code) {
    case "hash_conflict":
      return guidance(
        code,
        "The script changed since the caller last read it, so the write lock is stale.",
        ["Another Studio edit changed the script.", "The caller used an old expectedHash."],
        true,
        {
          tool: "rbx_get_script",
          endpoint: "/v1/agent/get_script",
          payloadTemplate: { path: ["Service", "ScriptName"], forceRefresh: true }
        },
        ["Retry only after reading a fresh hash.", "Do not reuse the stale expectedHash."]
      );
    case "version_conflict":
      return guidance(
        code,
        "The UI subtree version changed before the requested mutation was applied.",
        ["Another UI edit changed the subtree.", "The caller used an old expectedVersion."],
        true,
        {
          tool: "rbx_get_ui_tree",
          endpoint: "/v1/agent/get_ui_tree",
          payloadTemplate: { path: ["StarterGui", "ScreenGui"], forceRefresh: true }
        },
        ["Retry after a fresh subtree read.", "For large edits, prefer apply_ui_batch to reduce repeated conflicts."]
      );
    case "already_exists":
      return guidance(
        code,
        "The requested create target already exists.",
        ["A script or UI node with the same full path already exists."],
        false,
        null,
        ["Switch to update flow if you meant to modify the existing object."]
      );
    case "script_parent_not_found":
      return guidance(
        code,
        "The target parent for a script move does not exist.",
        ["The newParentPath is wrong.", "The target parent was deleted or renamed.", "Script moves do not auto-create parent chains."],
        false,
        {
          tool: "rbx_get_project_summary",
          endpoint: "/v1/agent/get_project_summary",
          payloadTemplate: { scope: "scripts" }
        },
        ["Create the parent path first or move the script to an existing parent."]
      );
    case "path_occupied_by_non_script_child":
      return guidance(
        code,
        "The destination script name is occupied by a non-script instance.",
        ["A Folder or other non-script object already exists at the target name."],
        false,
        {
          tool: "rbx_move_script",
          endpoint: "/v1/agent/move_script",
          payloadTemplate: { path: ["Service", "OldScript"], newParentPath: ["Service"], newName: "NewScriptName", expectedHash: "hash" }
        },
        ["Rename the script or remove the non-script blocker outside the script API."]
      );
    case "not_found":
      return guidance(
        code,
        "The requested script or UI path was not found in the refreshed source of truth.",
        ["The path is wrong.", "The object was deleted or renamed.", "The request targets the wrong project/session."],
        true,
        {
          tool: "rbx_search_text",
          endpoint: "/v1/agent/search_text",
          payloadTemplate: { query: "target name" }
        },
        ["For UI, also try search_ui if you know the screen/control name."]
      );
    case "path_blocked_by_non_ui_child":
      return guidance(
        code,
        "The UI traversal path is blocked by a non-UI instance such as Folder or Model.",
        ["A non-UI child occupies a segment in the requested UI path."],
        false,
        {
          tool: "rbx_get_ui_tree",
          endpoint: "/v1/agent/get_ui_tree",
          payloadTemplate: { path: ["ReplicatedFirst", "Screens", "ScreenName"], forceRefresh: true }
        },
        ["The UI API is strict UI-only.", "Use a UI class instead of Folder/Model in UI authoring flows."]
      );
    case "name_occupied_by_non_ui_child":
      return guidance(
        code,
        "The requested UI child name is already taken by a non-UI sibling.",
        ["A Folder/Model/non-UI child already exists with the same name."],
        false,
        {
          tool: "rbx_get_ui_tree",
          endpoint: "/v1/agent/get_ui_tree",
          payloadTemplate: { path: ["ReplicatedFirst", "Screens", "ScreenName"], forceRefresh: true }
        },
        ["Rename the new UI node or remove the non-UI blocker outside the UI API."]
      );
    case "ui_class_not_supported":
      return guidance(
        code,
        "The UI API only supports UI-relevant classes.",
        ["The request attempted to create or mutate Folder/Model or another non-UI class."],
        false,
        null,
        ["Use Frame, TextLabel, TextButton, ScreenGui and other UI classes only."]
      );
    case "delete_verification_failed":
      return guidance(
        code,
        "Studio acknowledged the delete, but the follow-up existence check still found the script.",
        ["The delete did not apply.", "A conflicting Studio/plugin state recreated the script immediately."],
        true,
        {
          tool: "rbx_get_script",
          endpoint: "/v1/agent/get_script",
          payloadTemplate: { path: ["Service", "ScriptName"], forceRefresh: true }
        },
        ["Retry only after confirming the current script state."]
      );
    case "patch_invalid":
      return guidance(
        code,
        "The structured script patch payload is malformed or targets invalid ranges.",
        ["One or more patch operations are missing required fields.", "A range is outside the current source.", "Two patch operations overlap in an invalid way."],
        false,
        {
          tool: "rbx_validate_operation",
          endpoint: "/v1/agent/validate_operation",
          payloadTemplate: { kind: "script_patch", payload: { path: ["Service", "ScriptName"], expectedHash: "hash", patch: [] } }
        },
        ["Validate the patch before write.", "Use line and column coordinates from a fresh read when applying range-based edits."]
      );
    case "patch_target_not_found":
      return guidance(
        code,
        "A text-targeted patch operation could not find the requested text occurrence in the refreshed source.",
        ["The oldText snippet no longer exists.", "The requested occurrence index is out of range.", "The script changed between planning and execution."],
        true,
        {
          tool: "rbx_get_script",
          endpoint: "/v1/agent/get_script",
          payloadTemplate: { path: ["Service", "ScriptName"], forceRefresh: true }
        },
        ["Refresh the script and rebuild the patch against the current source.", "Prefer replace_range when the exact location is already known."]
      );
    case "base_not_available":
      return guidance(
        code,
        "The requested diff base version is not available in the retained script history.",
        ["The baseHash was never seen in this cache.", "History retention already evicted the older version.", "No previous version exists yet for this script."],
        false,
        {
          tool: "rbx_get_script",
          endpoint: "/v1/agent/get_script",
          payloadTemplate: { path: ["Service", "ScriptName"], forceRefresh: true }
        },
        ["Script history is bounded and is not a full VCS replacement.", "Call diff_script soon after changes if you need review hunks."]
      );
    case "template_invalid":
      return guidance(
        code,
        "The requested UI template kind or options payload is invalid.",
        ["A required option such as name or title is missing.", "An unknown option key was supplied.", "The template kind is not supported."],
        false,
        {
          tool: "rbx_validate_operation",
          endpoint: "/v1/agent/validate_operation",
          payloadTemplate: {
            kind: "ui_template",
            payload: {
              kind: "modal",
              rootPath: ["StarterGui", "MainGui"],
              targetPath: ["StarterGui", "MainGui"],
              expectedVersion: "version",
              options: { name: "MyModal", title: "Title" }
            }
          }
        },
        ["Supported template kinds in this iteration are modal and shop_grid only."]
      );
    case "invalid_operation_kind":
      return guidance(
        code,
        "The validate_operation request used an unsupported operation kind.",
        ["kind is misspelled.", "The caller used a future or unknown operation kind."],
        false,
        {
          tool: "rbx_validate_operation",
          endpoint: "/v1/agent/validate_operation",
          payloadTemplate: { kind: "script_patch", payload: {} }
        },
        ["Supported kinds are script_delete, script_move, script_patch, ui_clone, ui_template, ui_batch, and ui_layout."]
      );
    case "ui_operation_out_of_root":
      return guidance(
        code,
        "The requested UI mutation would escape the declared mutation root.",
        ["sourcePath, targetPath, or newParentPath is outside rootPath.", "The clone/template request mixes unrelated UI roots."],
        false,
        {
          tool: "rbx_get_ui_tree",
          endpoint: "/v1/agent/get_ui_tree",
          payloadTemplate: { path: ["StarterGui", "MainGui"], forceRefresh: true }
        },
        ["Keep clone and template operations scoped to one rootPath for deterministic version locking."]
      );
    case "invalid_ui_operation":
      return guidance(
        code,
        "The UI batch payload is malformed or contains unresolved ref fields.",
        ["A batch op omitted both path and pathRef.", "A pathRef/parentRef/newParentRef points to an unknown id.", "The batch reuses the same id twice."],
        false,
        {
          tool: "rbx_validate_operation",
          endpoint: "/v1/agent/validate_operation",
          payloadTemplate: { kind: "ui_batch", payload: { rootPath: ["StarterGui", "MainGui"], expectedVersion: "version", operations: [] } }
        },
        ["Validate batch payloads before write when using pathRef/parentRef ergonomics.", "Check for unknown refs, duplicate ids, or mutually exclusive path/pathRef fields."]
      );
    case "partial_geometry_only":
      return guidance(
        code,
        "The requested UI subtree only supports partial edit-time geometry diagnostics.",
        ["The target is a SurfaceGui or BillboardGui.", "The target does not live in screen-space UI."],
        false,
        {
          tool: "rbx_get_ui_layout_snapshot",
          endpoint: "/v1/agent/get_ui_layout_snapshot",
          payloadTemplate: { path: ["StarterGui", "ScreenGui"], forceRefresh: true }
        },
        ["Treat geometry warnings as hints only for non-screen-space UI."]
      );
    case "layout_conflict":
      return guidance(
        code,
        "Multiple layout helpers or constraints on the same parent are competing for control.",
        ["The same parent contains more than one layout primitive.", "A helper/constraint stack is fighting over size or order."],
        false,
        {
          tool: "rbx_validate_ui_layout",
          endpoint: "/v1/agent/validate_ui_layout",
          payloadTemplate: { path: ["StarterGui", "ScreenGui"], forceRefresh: true, verbosity: "minimal" }
        },
        ["Inspect the parent container and keep only the intended layout primitive combination."]
      );
    case "project_mismatch":
      return guidance(
        code,
        "The request targeted a different placeId than the active server session.",
        ["The wrong port was used.", "The placeId guard rejected the request."],
        false,
        {
          endpoint: "/v1/agent/health",
          payloadTemplate: {}
        },
        ["Check active placeId/placeName before retrying.", "One port must map to one project."]
      );
    case "studio_offline":
      return guidance(
        code,
        "The server does not have an active Studio plugin session.",
        ["The plugin is disabled.", "The plugin is connected to a different port.", "Studio was closed."],
        true,
        {
          endpoint: "/v1/agent/health",
          payloadTemplate: {}
        },
        ["Reconnect the plugin before retrying cache refresh or writes."]
      );
    case "unsupported_command":
      return guidance(
        code,
        "The plugin does not support the requested bridge command.",
        ["Server and plugin versions are out of sync."],
        false,
        {
          endpoint: "/v1/agent/capabilities",
          payloadTemplate: {}
        },
        ["Reload the plugin from the current repo version."]
      );
    case "plugin_internal_error":
      return guidance(
        code,
        "The Roblox plugin hit an internal runtime error while executing the command.",
        ["Plugin-side Lua error.", "Unexpected Studio API failure."],
        true,
        {
          tool: "rbx_get_logs",
          endpoint: "/v1/agent/get_logs",
          payloadTemplate: { minLevel: "error", limit: 20 }
        },
        ["Inspect plugin logs and retry only after the runtime error is understood."]
      );
    default:
      return guidance(
        code,
        "The server returned an error code that does not have specialized guidance yet.",
        ["Inspect the error details and current capabilities.", "The caller may need a narrower or fresher read."],
        false,
        {
          endpoint: "/v1/agent/capabilities",
          payloadTemplate: {}
        },
        [details ? `Details were provided for this error.` : "No structured details were provided."]
      );
  }
}

export function recommendedNextStepByError(): Record<string, string> {
  return {
    hash_conflict: "get_script(forceRefresh=true) -> retry update_script with fresh expectedHash",
    version_conflict: "get_ui_tree(forceRefresh=true) -> retry update_ui/apply_ui_batch with fresh expectedVersion",
    already_exists: "switch from create flow to update/read flow for the existing target",
    not_found: "search_text or search_ui -> verify path -> retry targeted read",
    path_blocked_by_non_ui_child: "inspect parent UI path and remove or rename the non-UI blocker outside UI API",
    name_occupied_by_non_ui_child: "rename the new UI node or remove the blocking non-UI child",
    script_parent_not_found: "verify newParentPath and move the script only under an existing parent",
    path_occupied_by_non_script_child: "rename the script or remove the blocking non-script instance",
    ui_class_not_supported: "replace non-UI classes with UI-relevant classes",
    invalid_ui_operation: "validate_operation(ui_batch) -> fix pathRef/parentRef ids or path fields -> retry",
    partial_geometry_only: "treat layout diagnostics as hints only for SurfaceGui/BillboardGui or other non-screen-space UI",
    layout_conflict: "inspect the parent container and keep only the intended layout helper/constraint combination",
    patch_invalid: "validate_operation(script_patch) -> fix patch schema/ranges -> retry",
    patch_target_not_found: "get_script(forceRefresh=true) -> rebuild patch against current source -> retry",
    base_not_available: "use current script read or supply a newer baseHash still present in local history",
    delete_verification_failed: "refresh the script path and confirm Studio state before retrying delete",
    template_invalid: "validate_operation(ui_template) -> fix kind/options -> retry apply_ui_template",
    invalid_operation_kind: "use one of script_delete | script_move | script_patch | ui_clone | ui_template | ui_batch | ui_layout",
    ui_operation_out_of_root: "refresh root and keep source/target paths inside one rootPath",
    project_mismatch: "health -> verify port/placeId -> retry on the correct server",
    studio_offline: "reconnect plugin -> health -> retry",
    unsupported_command: "reload plugin to match server version",
    plugin_internal_error: "get_logs(minLevel=error) -> inspect plugin trace before retry"
  };
}
