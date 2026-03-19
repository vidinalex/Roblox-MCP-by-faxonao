export type ScriptClass = "Script" | "LocalScript" | "ModuleScript";
export type ScriptReadChannel = "editor" | "unknown";
export type ScriptWriteChannel = "editor";

export interface ScriptSnapshot {
  path: string[];
  service: string;
  name: string;
  className: ScriptClass;
  source: string;
  hash: string;
  updatedAt: string;
  draftAware: boolean;
  readChannel: ScriptReadChannel;
  tags: string[];
  attributes: Record<string, UiValue>;
}

export interface ScriptIndexRecord {
  key: string;
  path: string[];
  service: string;
  name: string;
  className: ScriptClass;
  hash: string;
  updatedAt: string;
  sourceFile: string;
  draftAware: boolean;
  readChannel: ScriptReadChannel;
  tags: string[];
  attributes: Record<string, UiValue>;
}

export type UiScalarValue = string | number | boolean;

export interface UiColor3Value {
  type: "Color3";
  r: number;
  g: number;
  b: number;
}

export interface UiUDimValue {
  type: "UDim";
  scale: number;
  offset: number;
}

export interface UiUDim2Value {
  type: "UDim2";
  x: UiUDimValue;
  y: UiUDimValue;
}

export interface UiVector2Value {
  type: "Vector2";
  x: number;
  y: number;
}

export interface UiVector3Value {
  type: "Vector3";
  x: number;
  y: number;
  z: number;
}

export interface UiEnumValue {
  type: "Enum";
  enumType: string;
  value: string;
}

export interface UiColorSequenceKeypointValue {
  time: number;
  value: UiColor3Value;
}

export interface UiColorSequenceValue {
  type: "ColorSequence";
  keypoints: UiColorSequenceKeypointValue[];
}

export interface UiNumberSequenceKeypointValue {
  time: number;
  value: number;
  envelope?: number;
}

export interface UiNumberSequenceValue {
  type: "NumberSequence";
  keypoints: UiNumberSequenceKeypointValue[];
}

export interface UiRectValue {
  type: "Rect";
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type UiValue =
  | UiScalarValue
  | UiColor3Value
  | UiUDimValue
  | UiUDim2Value
  | UiVector2Value
  | UiVector3Value
  | UiEnumValue
  | UiColorSequenceValue
  | UiNumberSequenceValue
  | UiRectValue;

export interface InstanceMetadataPatch {
  addTags?: string[];
  removeTags?: string[];
  attributes?: Record<string, UiValue>;
  clearAttributes?: string[];
}

export interface UiNodeSnapshot {
  path: string[];
  service: string;
  name: string;
  className: string;
  version: string;
  updatedAt: string;
  props: Record<string, UiValue>;
  tags: string[];
  attributes: Record<string, UiValue>;
  unsupportedProperties: string[];
  children: UiNodeSnapshot[];
}

export interface UiUpdatePropsOperation {
  op: "update_props";
  path?: string[];
  pathRef?: string;
  props: Record<string, UiValue>;
  clearProps?: string[];
}

export interface UiUpdateMetadataOperation {
  op: "update_metadata";
  path?: string[];
  pathRef?: string;
  addTags?: string[];
  removeTags?: string[];
  attributes?: Record<string, UiValue>;
  clearAttributes?: string[];
}

export interface UiCreateNodeOperation {
  op: "create_node";
  parentPath?: string[];
  parentRef?: string;
  className: string;
  name: string;
  props?: Record<string, UiValue>;
  tags?: string[];
  attributes?: Record<string, UiValue>;
  index?: number;
  id?: string;
}

export interface UiDeleteNodeOperation {
  op: "delete_node";
  path?: string[];
  pathRef?: string;
}

export interface UiMoveNodeOperation {
  op: "move_node";
  path?: string[];
  pathRef?: string;
  newParentPath?: string[];
  newParentRef?: string;
  index?: number;
}

export type UiMutationOp =
  | UiUpdatePropsOperation
  | UiUpdateMetadataOperation
  | UiCreateNodeOperation
  | UiDeleteNodeOperation
  | UiMoveNodeOperation;

export interface ScriptPatchReplaceRangeOp {
  op: "replace_range";
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  text: string;
}

export interface ScriptPatchReplaceTextOp {
  op: "replace_text";
  oldText: string;
  newText: string;
  occurrence?: number;
}

export interface ScriptPatchInsertAfterLineOp {
  op: "insert_after_line";
  line: number;
  text: string;
}

export interface ScriptPatchDeleteRangeOp {
  op: "delete_range";
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export type ScriptPatchOp =
  | ScriptPatchReplaceRangeOp
  | ScriptPatchReplaceTextOp
  | ScriptPatchInsertAfterLineOp
  | ScriptPatchDeleteRangeOp;

export interface UiRootIndexRecord {
  key: string;
  path: string[];
  service: string;
  name: string;
  className: string;
  version: string;
  updatedAt: string;
  treeFile: string;
}

export interface LogEntryRecord {
  id: string;
  time: string;
  level: "info" | "warn" | "error";
  message: string;
  cursor?: string;
  source?: string | null;
  playSessionId?: string | null;
  requestId?: string | null;
  commandId?: string | null;
}

export type ChangeJournalItemKind = "script" | "ui_root";
export type ChangeJournalChangeType = "snapshot_all" | "snapshot_partial" | "script_write" | "ui_write";

export interface ChangeJournalEntry {
  cursor: string;
  time: string;
  kind: ChangeJournalItemKind;
  path: string[];
  updatedAt: string;
  changeType: ChangeJournalChangeType;
}

export interface CacheIndex {
  placeId: string;
  placeName: string;
  updatedAt: string;
  writeMode: "draft_only";
  editorApiAvailable: boolean | null;
  lastReadChannel: ScriptReadChannel | null;
  lastWriteChannel: ScriptWriteChannel | null;
  indexVersion: number | null;
  indexUpdatedAt: string | null;
  uiIndexVersion: number | null;
  uiIndexUpdatedAt: string | null;
  scripts: Record<string, ScriptIndexRecord>;
  uiRoots: Record<string, UiRootIndexRecord>;
}

export type PlayState = "stopped" | "starting" | "playing" | "running" | "stopping" | "error";
export type PlayMode = "play" | "run";

export interface StudioSession {
  sessionId: string;
  clientId: string;
  placeId: string;
  placeName: string;
  pluginVersion: string;
  editorApiAvailable: boolean | null;
  base64Transport: boolean;
  playApiAvailable: boolean | null;
  logCaptureAvailable: boolean | null;
  playState: PlayState;
  playMode: PlayMode | null;
  playSessionId: string | null;
  connectedAt: string;
  lastSeenAt: string;
  lastPollAt: string | null;
}

export interface BridgeCommand {
  commandId: string;
  sessionId: string;
  type:
    | "snapshot_all_scripts"
    | "snapshot_script_by_path"
    | "snapshot_scripts_by_paths"
    | "set_script_source_if_hash"
    | "set_script_metadata_if_hash"
    | "upsert_script"
    | "delete_script_if_hash"
    | "move_script_if_hash"
    | "snapshot_ui_roots"
    | "snapshot_ui_subtree_by_path"
    | "snapshot_ui_layout_by_path"
    | "mutate_ui_batch_if_version";
  payload: Record<string, unknown>;
  createdAt: string;
  timeoutMs: number;
  requestId?: string;
}

export interface CommandResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
