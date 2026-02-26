// =============================================================================
// Tokenize — Auto Layout Spacing Auditor
// Figma Plugin: code.ts (runs in the plugin sandbox)
// =============================================================================
//
// This plugin scans Auto Layout nodes for hardcoded spacing values and replaces
// them with matching variables from the linked foundation design system library.
//
// Message protocol (plugin ↔ UI):
//   plugin → ui:  { type: 'scan-results', findings: Finding[], availableTokens: AvailableToken[] }
//                 { type: 'replace-done', replaced: number, unresolved: number, findings: Finding[] }
//                 { type: 'tokens-list', tokens: AvailableToken[] }
//                 { type: 'debug-log', entries: LogEntry[] }
//                 { type: 'error', message: string }
//                 { type: 'collections-list', local: CollectionInfo[], library: LibraryCollectionInfo[] }
//                 { type: 'progress', phase: 'tokens' | 'scan', current?: number, total?: number }
//   ui → plugin:  { type: 'scan', collectionFilter: string,
//                          selectedLocalIds?: string[], selectedLibraryKeys?: string[] }
//                 { type: 'replace', findings: Finding[] }
//                 { type: 'get-collections' }
//                 { type: 'get-tokens', collectionFilter: string,
//                          selectedLocalIds?: string[], selectedLibraryKeys?: string[] }
//                 { type: 'copy-log' }  (handled in ui)
// =============================================================================

figma.showUI(__html__, { width: 420, height: 640, title: "Tokenize – Spacing Auditor" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The spacing CSS-like properties we audit on Auto Layout nodes. */
type SpacingProperty =
  | "itemSpacing"
  | "paddingTop"
  | "paddingBottom"
  | "paddingLeft"
  | "paddingRight"
  | "counterAxisSpacing";

/** A single finding: one property on one node that has a hardcoded value. */
interface Finding {
  nodeId: string;
  nodeName: string;
  property: SpacingProperty;
  rawValue: number;
  /** Variable id if a match was found, otherwise null. */
  matchedVariableId: string | null;
  /** Human-readable variable name for display. */
  matchedVariableName: string | null;
  /** Already replaced in this session? */
  replaced: boolean;
}

/** A log entry for the debug panel. */
interface LogEntry {
  level: "info" | "warn" | "error" | "success";
  message: string;
  timestamp: number;
}

/** Describes a local variable collection available for selection. */
interface CollectionInfo {
  id: string;
  name: string;
}

/** Describes a library variable collection available for selection. */
interface LibraryCollectionInfo {
  key: string;
  name: string;
  libraryName: string;
}

// ---------------------------------------------------------------------------
// Global debug log accumulator
// We batch-send entries to the UI after each major phase so the UI stays
// responsive rather than receiving one message per log line.
// ---------------------------------------------------------------------------

const debugLog: LogEntry[] = [];

function log(level: LogEntry["level"], message: string): void {
  const entry: LogEntry = { level, message, timestamp: Date.now() };
  debugLog.push(entry);
  console.log(`[${level.toUpperCase()}] ${message}`);
}

function flushLog(): void {
  figma.ui.postMessage({ type: "debug-log", entries: [...debugLog] });
  // Keep the accumulator so the UI can display the full history after a
  // subsequent flush, but trim very long logs to avoid memory issues.
  if (debugLog.length > 2000) debugLog.splice(0, debugLog.length - 2000);
}

// ---------------------------------------------------------------------------
// Resolved variable cache
// Maps numeric value → Variable (scoped to the current run so stale imports
// from a previous run are not used).
// ---------------------------------------------------------------------------

interface ResolvedVar {
  variable: Variable;
  name: string;
}

/** A token surfaced to the UI so unmatched groups can be assigned a token. */
interface AvailableToken {
  id: string;
  name: string;
  /** Resolved numeric value, or null when the variable holds an alias reference. */
  value: number | null;
}

let valueToVariableMap: Map<number, ResolvedVar> = new Map();
// Cache of variable id → Variable object, populated during scan so that
// applyReplacements can pass live (fully-hydrated) objects to setBoundVariable
// without triggering the internal sync getVariableById call.
let variableByIdCache: Map<string, Variable> = new Map();

// ---------------------------------------------------------------------------
// All spacing properties we check on each Auto Layout node
// ---------------------------------------------------------------------------

const SPACING_PROPERTIES: SpacingProperty[] = [
  "itemSpacing",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "counterAxisSpacing",
];

// ---------------------------------------------------------------------------
// Collection discovery — for the library picker UI
// ---------------------------------------------------------------------------

/**
 * Fetch all local and library variable collections and return them so the UI
 * can present a collection picker to the user.
 */
async function getAvailableCollections(): Promise<{
  local: CollectionInfo[];
  library: LibraryCollectionInfo[];
}> {
  const local: CollectionInfo[] = [];
  const library: LibraryCollectionInfo[] = [];

  try {
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    for (const c of cols) {
      local.push({ id: c.id, name: c.name });
    }
  } catch (_) {
    // Non-fatal — return empty list
  }

  if (typeof figma.teamLibrary !== "undefined") {
    try {
      const libCols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      for (const lc of libCols) {
        library.push({ key: lc.key, name: lc.name, libraryName: lc.libraryName });
      }
    } catch (_) {
      // Non-fatal — return empty list
    }
  }

  return { local, library };
}

// ---------------------------------------------------------------------------
// Phase 1 — Variable discovery & resolution
// ---------------------------------------------------------------------------

/**
 * Build a map of  resolved pixel value → Variable  for all spacing variables.
 *
 * When the user has explicitly selected collections in the UI, those keys/IDs
 * are used directly (bypassing the name filter).  If nothing is explicitly
 * selected the filter string falls back to substring-matching collection names.
 *
 * Strategy (in order):
 *  1. getLocalVariables() — catches local + already-imported library vars.
 *  2. getAvailableLibraryVariableCollectionsAsync() — fetches remote library
 *     collection list, then imports each variable by key.
 *  3. Surface a clear error if everything fails.
 */
async function buildValueMap(
  collectionFilter: string,
  selectedLocalIds: string[] = [],
  selectedLibraryKeys: string[] = []
): Promise<void> {
  valueToVariableMap = new Map();
  variableByIdCache = new Map();

  const usingExplicitSelection = selectedLocalIds.length > 0 || selectedLibraryKeys.length > 0;

  figma.ui.postMessage({ type: "progress", phase: "tokens" });

  log(
    "info",
    usingExplicitSelection
      ? `=== Variable Discovery (explicit selection: ${selectedLocalIds.length} local, ${selectedLibraryKeys.length} library) ===`
      : `=== Variable Discovery (filter: "${collectionFilter}") ===`
  );

  // --- Step 1: Local variables (includes already-imported library vars) ---
  let localVars: Variable[] = [];
  try {
    localVars = await figma.variables.getLocalVariablesAsync("FLOAT");
    log("info", `getLocalVariablesAsync() returned ${localVars.length} FLOAT variables`);
  } catch (err) {
    log("warn", `getLocalVariablesAsync() failed: ${err}`);
  }

  // Identify all collections to show the user what's available
  let allCollections: VariableCollection[] = [];
  try {
    allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    log("info", `Found ${allCollections.length} local collection(s):`);
    for (const col of allCollections) {
      log("info", `  • "${col.name}" (id=${col.id}, remote=${col.remote})`);
    }
  } catch (err) {
    log("warn", `getLocalVariableCollections() failed: ${err}`);
  }

  // Determine which local collection IDs to include
  let matchingCollectionIds: Set<string>;
  if (usingExplicitSelection && selectedLocalIds.length > 0) {
    matchingCollectionIds = new Set(selectedLocalIds);
    log("info", `Using ${selectedLocalIds.length} explicitly selected local collection(s)`);
  } else if (!usingExplicitSelection) {
    // Fall back to name filter
    const filterLower = collectionFilter.toLowerCase();
    matchingCollectionIds = new Set(
      allCollections
        .filter((c) => c.name.toLowerCase().includes(filterLower))
        .map((c) => c.id)
    );
    if (matchingCollectionIds.size === 0) {
      log("warn", `No local collections matched filter "${collectionFilter}".`);
      log(
        "warn",
        `Available collection names: ${allCollections.map((c) => `"${c.name}"`).join(", ") || "(none)"}`
      );
    } else {
      log("info", `Matched ${matchingCollectionIds.size} collection(s) by filter "${collectionFilter}"`);
    }
  } else {
    matchingCollectionIds = new Set();
  }

  // Ingest matched local variables
  for (const v of localVars) {
    if (!matchingCollectionIds.has(v.variableCollectionId)) continue;
    ingestVariable(v);
  }

  log(
    "info",
    `After local pass: ${valueToVariableMap.size} unique spacing value(s) mapped`
  );

  // Skip the library pass only when we are in filter-only mode and local tokens
  // already satisfy the request.  When the user has explicitly checked collections
  // in the picker we must always honour those selections — even if local tokens
  // were found — because the user may have selected a library collection that
  // contains the tokens they actually want.
  if (!usingExplicitSelection && valueToVariableMap.size > 0) {
    flushLog();
    return;
  }

  // --- Step 2: Team library collections ---
  log("info", usingExplicitSelection
    ? "Explicit library selection — importing selected collections…"
    : "No local spacing variables found — attempting library import…"
  );

  // Guard: teamLibrary may not exist in older API versions.
  if (typeof figma.teamLibrary === "undefined") {
    log("warn", "figma.teamLibrary is undefined (older plugin API). Cannot fetch remote libraries.");
    flushLog();
    return;
  }

  let libCollections: LibraryVariableCollection[] = [];
  try {
    libCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    log("info", `getAvailableLibraryVariableCollectionsAsync() returned ${libCollections.length} collection(s):`);
    for (const lc of libCollections) {
      log("info", `  • "${lc.name}" (libraryName="${lc.libraryName}", key=${lc.key})`);
    }
  } catch (err) {
    log("error", `getAvailableLibraryVariableCollectionsAsync() failed: ${err}`);
    flushLog();
    return;
  }

  // Determine which library collections to import from
  let matchingLibCollections: LibraryVariableCollection[];
  if (usingExplicitSelection && selectedLibraryKeys.length > 0) {
    const keySet = new Set(selectedLibraryKeys);
    matchingLibCollections = libCollections.filter((lc) => keySet.has(lc.key));
    log("info", `Using ${matchingLibCollections.length} explicitly selected library collection(s)`);
  } else if (!usingExplicitSelection) {
    const filterLower = collectionFilter.toLowerCase();
    matchingLibCollections = libCollections.filter((lc) =>
      lc.name.toLowerCase().includes(filterLower)
    );
  } else {
    matchingLibCollections = [];
  }

  if (matchingLibCollections.length === 0) {
    log(
      "warn",
      usingExplicitSelection
        ? `None of the selected library collections were found. Available: ${libCollections.map((c) => `"${c.name}"`).join(", ") || "(none)"}`
        : `No library collections matched filter "${collectionFilter}". ` +
            `Available: ${libCollections.map((c) => `"${c.name}"`).join(", ") || "(none)"}`
    );
    flushLog();
    return;
  }

  log(
    "info",
    `Matched ${matchingLibCollections.length} library collection(s). Importing variables...`
  );

  // --- Step 3: Import individual variables from matched library collections ---
  for (const libCol of matchingLibCollections) {
    log("info", `  Fetching variable list from "${libCol.name}" (${libCol.libraryName})...`);

    let libVarStubs: LibraryVariable[] = [];
    try {
      libVarStubs = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(libCol.key);
      log("info", `  Found ${libVarStubs.length} variable(s) in this collection`);
    } catch (err) {
      log("error", `  getVariablesInLibraryCollectionAsync failed for "${libCol.name}": ${err}`);
      continue;
    }

    // Import in batches to avoid overwhelming the Figma API with hundreds of
    // concurrent requests (which can cause the sandbox to freeze).
    const IMPORT_BATCH = 10;
    for (let i = 0; i < libVarStubs.length; i += IMPORT_BATCH) {
      const batch = libVarStubs.slice(i, i + IMPORT_BATCH);
      const batchResults = await Promise.allSettled(
        batch.map((stub) => figma.variables.importVariableByKeyAsync(stub.key))
      );
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === "fulfilled") {
          ingestVariable(result.value);
        } else {
          log("warn", `  Import failed for variable "${batch[j].name}" (key=${batch[j].key}): ${result.reason}`);
        }
      }
      // Yield between batches so the UI stays responsive during large imports.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  log(
    "info",
    `After library import pass: ${valueToVariableMap.size} unique spacing value(s) mapped`
  );
  flushLog();
}

/**
 * Attempt to read the resolved numeric value from a Variable and register it
 * in the value→variable map.
 */
function ingestVariable(v: Variable): void {
  if (v.resolvedType !== "FLOAT") return;

  const modeKeys = Object.keys(v.valuesByMode);
  if (modeKeys.length === 0) {
    log("warn", `Variable "${v.name}" has no valuesByMode entries`);
    return;
  }

  // Use the first available mode key (callers can refine this if needed).
  const modeKey = modeKeys[0];
  const raw = v.valuesByMode[modeKey];

  log(
    "info",
    `  Ingesting var "${v.name}" | id=${v.id} | mode=${modeKey} | valuesByMode[mode]=${raw}`
  );

  // Always cache by id — includes alias variables so every FLOAT token from the
  // selected collection is available for group assignment, even when its value
  // cannot be resolved to a plain number (e.g. it references another variable).
  variableByIdCache.set(v.id, v);

  if (typeof raw !== "number") {
    log("warn", `  Skipping "${v.name}" for value-matching — value is not a direct number (alias?)`);
    return;
  }

  // Zero-value tokens can never be matched: checkProperty silently ignores
  // 0px spacing properties, so registering 0 in the map is pointless.
  // The variable is still in variableByIdCache for group-assign dropdowns.
  if (raw === 0) return;

  // Only override if not already set (first-match wins, keeps it deterministic)
  if (!valueToVariableMap.has(raw)) {
    valueToVariableMap.set(raw, { variable: v, name: v.name });
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — Node scanning
// ---------------------------------------------------------------------------

/** Count all nodes in a set of roots (iterative, no stack-overflow risk). */
function countNodes(roots: SceneNode[]): number {
  let count = 0;
  const stack: SceneNode[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count++;
    if ("children" in node) {
      for (const child of (node as ChildrenMixin).children) {
        stack.push(child);
      }
    }
  }
  return count;
}

/**
 * Iterative, async scan of all roots.
 * Yields control back to the plugin sandbox every ~16 ms so the UI spinner
 * stays responsive on large files, and sends progress messages so the UI
 * can show a deterministic "X / Y nodes" counter.
 */
async function scanAllNodes(roots: SceneNode[]): Promise<Finding[]> {
  const total = countNodes(roots);
  figma.ui.postMessage({ type: "progress", phase: "scan", current: 0, total });

  const allFindings: Finding[] = [];
  // Push in reverse so the first root is processed first (stack is LIFO).
  const stack: SceneNode[] = [...roots].reverse();
  let scanned = 0;
  let lastYield = Date.now();

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (
      "layoutMode" in node &&
      node.layoutMode !== "NONE" &&
      node.layoutMode !== undefined
    ) {
      log("info", `Scanning Auto Layout node: "${node.name}" (type=${node.type}, mode=${node.layoutMode})`);
      for (const prop of SPACING_PROPERTIES) {
        const finding = checkProperty(node as FrameNode | ComponentNode | InstanceNode, prop);
        if (finding) allFindings.push(finding);
      }
    }

    if ("children" in node) {
      const children = (node as ChildrenMixin).children;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }

    scanned++;

    // Yield every ~16 ms (one frame) to keep the UI responsive.
    if (Date.now() - lastYield >= 16) {
      figma.ui.postMessage({ type: "progress", phase: "scan", current: scanned, total });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      lastYield = Date.now();
    }
  }

  figma.ui.postMessage({ type: "progress", phase: "scan", current: scanned, total });
  return allFindings;
}

/**
 * Check one spacing property on one node.
 * Returns a Finding if the value is hardcoded (not already variable-bound),
 * or null if the property is already tokenized or not applicable.
 *
 * Deliberately silent on early-return paths (not-a-number, zero, already-bound)
 * because those are the majority of calls on any real document and logging them
 * generates thousands of noise entries that slow down flushLog significantly.
 */
function checkProperty(
  node: FrameNode | ComponentNode | InstanceNode,
  prop: SpacingProperty
): Finding | null {
  // counterAxisSpacing only exists when counterAxisAlignItems is 'BASELINE'
  // or when wrapping is enabled — it may be absent; guard with a type check.
  const rawValue: unknown = (node as unknown as Record<string, unknown>)[prop];
  // Not present / not a number → nothing to audit.
  if (typeof rawValue !== "number") return null;
  // Zero spacing is intentional and has no token to match against.
  if (rawValue === 0) return null;
  // Already bound to a variable → already tokenized.
  const boundVars = node.boundVariables as Record<string, VariableAlias | undefined> | undefined;
  if (boundVars?.[prop] !== undefined) return null;

  // Look up in our value map
  const match = valueToVariableMap.get(rawValue);

  if (match) {
    log("success", `  Match: ${node.name}.${prop}=${rawValue} → "${match.name}"`);
  } else {
    log("warn", `  No match: ${node.name}.${prop}=${rawValue} (${valueToVariableMap.size} tokens loaded)`);
  }

  return {
    nodeId: node.id,
    nodeName: node.name,
    property: prop,
    rawValue,
    matchedVariableId: match ? match.variable.id : null,
    matchedVariableName: match ? match.name : null,
    replaced: false,
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — Replacement
// ---------------------------------------------------------------------------

/**
 * Apply variable bindings for all findings that have a matched variable.
 * Returns the updated findings array (with replaced flags set).
 *
 * Performance strategy:
 *  - Skips findings that are already replaced (idempotent guard).
 *  - Deduplicates + parallelises variable pre-fetches so each missing variable
 *    is fetched exactly once and all fetches run concurrently.
 *  - Groups findings by nodeId (a node with 6 spacing properties produced 6
 *    findings, but we only need one getNodeByIdAsync call per node).
 *  - Fetches nodes in batches of 20 concurrently instead of one-at-a-time,
 *    dramatically cutting the number of sequential round-trips.
 *  - Yields between every node batch so the UI stays responsive.
 */
async function applyReplacements(findings: Finding[]): Promise<Finding[]> {
  log("info", "=== Applying Replacements ===");

  // --- Pre-fetch variables not yet in the cache (parallel, deduplicated) ---
  const missingVarIds = [
    ...new Set(
      findings
        .filter((f) => f.matchedVariableId && !f.replaced && !variableByIdCache.has(f.matchedVariableId))
        .map((f) => f.matchedVariableId as string)
    ),
  ];
  if (missingVarIds.length > 0) {
    await Promise.allSettled(
      missingVarIds.map(async (varId) => {
        try {
          const v = await figma.variables.getVariableByIdAsync(varId);
          if (v) variableByIdCache.set(varId, v);
        } catch (err) {
          log("warn", `Pre-fetch failed for variable id=${varId}: ${err}`);
        }
      })
    );
  }

  // --- Group pending findings by nodeId (skip already-replaced / unmatched) ---
  const nodeGroups = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!finding.matchedVariableId || finding.replaced) continue;
    if (!nodeGroups.has(finding.nodeId)) nodeGroups.set(finding.nodeId, []);
    nodeGroups.get(finding.nodeId)!.push(finding);
  }

  const nodeIds = [...nodeGroups.keys()];
  const totalMatched = [...nodeGroups.values()].reduce((s, g) => s + g.length, 0);
  let replaced = 0;
  let skipped = 0;
  let processed = 0;

  figma.ui.postMessage({ type: "progress", phase: "replace", current: 0, total: totalMatched });

  // --- Fetch nodes in batches and apply bindings ---
  // Batching parallelises the async lookups while keeping concurrency bounded
  // so we don't overwhelm the Figma sandbox with too many in-flight requests.
  const NODE_BATCH = 20;
  for (let bi = 0; bi < nodeIds.length; bi += NODE_BATCH) {
    const batchIds = nodeIds.slice(bi, bi + NODE_BATCH);
    const batchNodes = await Promise.allSettled(
      batchIds.map((id) => figma.getNodeByIdAsync(id))
    );

    for (let j = 0; j < batchIds.length; j++) {
      const nodeId = batchIds[j];
      const nodeFindings = nodeGroups.get(nodeId)!;
      const result = batchNodes[j];

      if (result.status === "rejected" || !result.value) {
        log("error", `Node "${nodeFindings[0].nodeName}" (id=${nodeId}) not found — may have been deleted`);
        skipped += nodeFindings.length;
        processed += nodeFindings.length;
      } else {
        const node = result.value;
        for (const finding of nodeFindings) {
          const variable = variableByIdCache.get(finding.matchedVariableId!);
          if (!variable) {
            log("error", `Variable id=${finding.matchedVariableId} not found for "${finding.nodeName}.${finding.property}"`);
            skipped++;
          } else {
            try {
              (node as FrameNode).setBoundVariable(finding.property as VariableBindableNodeField, variable);
              log("success", `  ✓ ${finding.nodeName}.${finding.property} → "${variable.name}"`);
              finding.replaced = true;
              replaced++;
            } catch (err) {
              log("error", `  ✗ setBoundVariable failed: ${finding.nodeName}.${finding.property}: ${err}`);
              skipped++;
            }
          }
          processed++;
        }
      }
    }

    figma.ui.postMessage({ type: "progress", phase: "replace", current: processed, total: totalMatched });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  log("info", `Replacement complete: ${replaced} replaced, ${skipped} skipped/unresolved`);
  flushLog();
  return findings;
}

// ---------------------------------------------------------------------------
// Root scan orchestrator
// ---------------------------------------------------------------------------

async function runScan(
  collectionFilter: string,
  selectedLocalIds: string[] = [],
  selectedLibraryKeys: string[] = []
): Promise<Finding[]> {
  log("info", `=== Scan Started (scope=selection) ===`);

  // Validate that something is selected
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    throw new Error("No selection. Please select a frame or artboard to scan.");
  }

  // Validate that at least one selected node is a frame or artboard
  const frameTypes = new Set<string>(["FRAME", "COMPONENT", "INSTANCE"]);
  const hasFrame = selection.some(node => frameTypes.has(node.type));
  if (!hasFrame) {
    throw new Error(
      "Selection contains no frames or artboards. Please select at least one frame or artboard and try again."
    );
  }

  // Build the value→variable map first
  await buildValueMap(collectionFilter, selectedLocalIds, selectedLibraryKeys);

  // Scan only the selected nodes
  const roots: SceneNode[] = [...selection];
  log("info", `Scanning ${roots.length} selected node(s)`);

  const allFindings = await scanAllNodes(roots);

  log(
    "info",
    `Scan complete: ${allFindings.length} hardcoded spacing propert${allFindings.length === 1 ? "y" : "ies"} found`
  );
  flushLog();

  return allFindings;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

// Send the collection list to the UI as soon as the plugin opens so the
// picker is populated without the user having to click anything.
getAvailableCollections().then(({ local, library }) => {
  figma.ui.postMessage({ type: "collections-list", local, library });
});

figma.ui.onmessage = async (msg: {
  type: string;
  collectionFilter?: string;
  selectedLocalIds?: string[];
  selectedLibraryKeys?: string[];
  findings?: Finding[];
  nodeId?: string;
}) => {
  // ---- Collection list request (manual refresh) ----
  if (msg.type === "get-collections") {
    const { local, library } = await getAvailableCollections();
    figma.ui.postMessage({ type: "collections-list", local, library });
    return;
  }

  // ---- Scan request ----
  if (msg.type === "scan") {
    const filter = msg.collectionFilter ?? "spacing";
    const selectedLocalIds = msg.selectedLocalIds ?? [];
    const selectedLibraryKeys = msg.selectedLibraryKeys ?? [];

    try {
      const findings = await runScan(filter, selectedLocalIds, selectedLibraryKeys);
      // Collect available tokens from the full cache so the UI can populate
      // group-assign dropdowns. Using variableByIdCache (not valueToVariableMap)
      // ensures alias variables are included — they're valid for assignment even
      // though they can't be matched by numeric value during scanning.
      const availableTokens: AvailableToken[] = [...variableByIdCache.entries()]
        .map(([id, v]) => {
          const modeKeys = Object.keys(v.valuesByMode);
          const raw = modeKeys.length > 0 ? v.valuesByMode[modeKeys[0]] : undefined;
          return { id, name: v.name, value: typeof raw === "number" ? raw : null };
        })
        .sort((a, b) => {
          // Numeric tokens first (sorted by value), then aliases sorted by name
          if (a.value !== null && b.value !== null) return a.value - b.value;
          if (a.value !== null) return -1;
          if (b.value !== null) return 1;
          return a.name.localeCompare(b.name);
        });
      figma.ui.postMessage({ type: "scan-results", findings, availableTokens });
    } catch (err) {
      const errMsg = `Scan failed: ${err}`;
      log("error", errMsg);
      flushLog();
      figma.ui.postMessage({ type: "error", message: errMsg });
    }
    return;
  }

  // ---- Replace request ----
  if (msg.type === "replace") {
    const findings: Finding[] = msg.findings ?? [];

    try {
      const updated = await applyReplacements(findings);
      const replacedCount = updated.filter((f) => f.replaced).length;
      const unresolvedCount = updated.filter((f) => !f.replaced).length;
      figma.ui.postMessage({
        type: "replace-done",
        replaced: replacedCount,
        unresolved: unresolvedCount,
        findings: updated,
      });
    } catch (err) {
      const errMsg = `Replace failed: ${err}`;
      log("error", errMsg);
      flushLog();
      figma.ui.postMessage({ type: "error", message: errMsg });
    }
    return;
  }

  // ---- Get tokens request (populate group-assign dropdowns without re-scanning) ----
  // The UI sends this when the post-scan availableTokens list was empty.  The user
  // selects the correct collection in the picker and clicks "Load tokens"; we load
  // all FLOAT variables from that selection and return them so the dropdowns fill.
  if (msg.type === "get-tokens") {
    const filter = msg.collectionFilter ?? "spacing";
    const selectedLocalIds = msg.selectedLocalIds ?? [];
    const selectedLibraryKeys = msg.selectedLibraryKeys ?? [];

    try {
      await buildValueMap(filter, selectedLocalIds, selectedLibraryKeys);
      const tokens: AvailableToken[] = [...variableByIdCache.entries()]
        .map(([id, v]) => {
          const modeKeys = Object.keys(v.valuesByMode);
          const raw = modeKeys.length > 0 ? v.valuesByMode[modeKeys[0]] : undefined;
          return { id, name: v.name, value: typeof raw === "number" ? raw : null };
        })
        .sort((a, b) => {
          if (a.value !== null && b.value !== null) return a.value - b.value;
          if (a.value !== null) return -1;
          if (b.value !== null) return 1;
          return a.name.localeCompare(b.name);
        });
      log("info", `get-tokens: returning ${tokens.length} token(s)`);
      flushLog();
      figma.ui.postMessage({ type: "tokens-list", tokens });
    } catch (err) {
      const errMsg = `get-tokens failed: ${err}`;
      log("error", errMsg);
      flushLog();
      figma.ui.postMessage({ type: "tokens-list", tokens: [] });
    }
    return;
  }

  // ---- Select node request ----
  if (msg.type === "select-node" && msg.nodeId) {
    const node = await figma.getNodeByIdAsync(msg.nodeId);
    if (node && node.type !== "DOCUMENT" && node.type !== "PAGE") {
      figma.currentPage.selection = [node as SceneNode];
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    }
    return;
  }
};
