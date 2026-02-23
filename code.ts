// =============================================================================
// Tokenize — Auto Layout Spacing Auditor
// Figma Plugin: code.ts (runs in the plugin sandbox)
// =============================================================================
//
// This plugin scans Auto Layout nodes for hardcoded spacing values and replaces
// them with matching variables from the linked foundation design system library.
//
// Message protocol (plugin ↔ UI):
//   plugin → ui:  { type: 'scan-results', findings: Finding[] }
//                 { type: 'replace-done', replaced: number, unresolved: number, findings: Finding[] }
//                 { type: 'debug-log', entries: LogEntry[] }
//                 { type: 'error', message: string }
//                 { type: 'collections-list', local: CollectionInfo[], library: LibraryCollectionInfo[] }
//                 { type: 'progress', phase: 'tokens' | 'scan', current?: number, total?: number }
//   ui → plugin:  { type: 'scan', collectionFilter: string, scope: 'selection' | 'page',
//                          selectedLocalIds?: string[], selectedLibraryKeys?: string[] }
//                 { type: 'replace', findings: Finding[] }
//                 { type: 'get-collections' }
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
    const cols = figma.variables.getLocalVariableCollections();
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
    localVars = figma.variables.getLocalVariables("FLOAT");
    log("info", `getLocalVariables() returned ${localVars.length} FLOAT variables`);
  } catch (err) {
    log("warn", `getLocalVariables() failed: ${err}`);
  }

  // Identify all collections to show the user what's available
  let allCollections: VariableCollection[] = [];
  try {
    allCollections = figma.variables.getLocalVariableCollections();
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

  // If we already have a good map, skip the library import pass (faster).
  if (valueToVariableMap.size > 0) {
    flushLog();
    return;
  }

  // --- Step 2: Team library collections ---
  log("info", "No local spacing variables found — attempting library import...");

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

    // Fire all imports in parallel — eliminates per-variable round-trip latency.
    const importResults = await Promise.allSettled(
      libVarStubs.map(stub => figma.variables.importVariableByKeyAsync(stub.key))
    );
    for (let i = 0; i < importResults.length; i++) {
      const result = importResults[i];
      if (result.status === "fulfilled") {
        ingestVariable(result.value);
      } else {
        log("warn", `  Import failed for variable "${libVarStubs[i].name}" (key=${libVarStubs[i].key}): ${result.reason}`);
      }
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

  if (typeof raw !== "number") {
    log("warn", `  Skipping "${v.name}" — resolved value is not a number (got ${typeof raw})`);
    return;
  }

  // Always cache by id so applyReplacements can pass the live object to
  // setBoundVariable without triggering an internal sync getVariableById.
  variableByIdCache.set(v.id, v);

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

    log("info", `Scanning node: "${node.name}" (type=${node.type})`);

    if (
      "layoutMode" in node &&
      node.layoutMode !== "NONE" &&
      node.layoutMode !== undefined
    ) {
      log("info", `  Auto Layout detected (mode=${node.layoutMode})`);
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
 */
function checkProperty(
  node: FrameNode | ComponentNode | InstanceNode,
  prop: SpacingProperty
): Finding | null {
  // counterAxisSpacing only exists when counterAxisAlignItems is 'BASELINE'
  // or when wrapping is enabled — it may be absent; guard with a type check.
  // Cast through unknown to safely read an arbitrary property by string key.
  const rawValue: unknown = (node as unknown as Record<string, unknown>)[prop];
  if (typeof rawValue !== "number") {
    log("info", `    ${prop}: not present or not a number, skipping`);
    return null;
  }

  // A spacing of 0 is intentional and has no meaningful token to match against.
  if (rawValue === 0) {
    log("info", `    ${prop}: 0 — zero spacing, skipping token match`);
    return null;
  }

  // Check if already bound to a variable
  const boundVars = node.boundVariables as Record<string, VariableAlias | undefined> | undefined;
  const alreadyBound = boundVars && prop in boundVars && boundVars[prop] !== undefined;

  if (alreadyBound) {
    log("info", `    ${prop}: ${rawValue} — already bound to variable, skipping`);
    return null;
  }

  log("info", `    ${prop}: ${rawValue} — hardcoded, checking for match...`);

  // Look up in our value map
  const match = valueToVariableMap.get(rawValue);

  if (match) {
    log("success", `    Match found: ${prop}=${rawValue} → "${match.name}"`);
  } else {
    const candidates = [...valueToVariableMap.keys()].sort((a, b) => a - b).join(", ");
    log("warn", `    No match for ${prop}=${rawValue}. Available values: [${candidates || "none"}]`);
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
 */
async function applyReplacements(findings: Finding[]): Promise<Finding[]> {
  log("info", "=== Applying Replacements ===");

  let replaced = 0;
  let skipped = 0;

  for (const finding of findings) {
    if (!finding.matchedVariableId) {
      skipped++;
      continue;
    }

    const node = await figma.getNodeByIdAsync(finding.nodeId);
    if (!node) {
      log("error", `Node "${finding.nodeName}" (id=${finding.nodeId}) not found — may have been deleted`);
      skipped++;
      continue;
    }

    // Prefer the live variable object cached during scan so that
    // setBoundVariable receives a fully-hydrated object and does not
    // trigger an internal sync getVariableById call (blocked under
    // documentAccess: "dynamic-page").
    const variable = variableByIdCache.get(finding.matchedVariableId)
      ?? await figma.variables.getVariableByIdAsync(finding.matchedVariableId);
    if (!variable) {
      log("error", `Variable id=${finding.matchedVariableId} not found for "${finding.nodeName}.${finding.property}"`);
      skipped++;
      continue;
    }

    log(
      "info",
      `setBoundVariable(node="${finding.nodeName}", prop=${finding.property}, var="${variable.name}")`
    );

    try {
      (node as FrameNode).setBoundVariable(finding.property as VariableBindableNodeField, variable);
      log("success", `  ✓ Bound ${finding.property} on "${finding.nodeName}" → "${variable.name}"`);
      finding.replaced = true;
      replaced++;
    } catch (err) {
      log("error", `  ✗ setBoundVariable failed for "${finding.nodeName}.${finding.property}": ${err}`);
      skipped++;
    }
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
  scope: "selection" | "page",
  selectedLocalIds: string[] = [],
  selectedLibraryKeys: string[] = []
): Promise<Finding[]> {
  log("info", `=== Scan Started (scope=${scope}) ===`);

  // Build the value→variable map first
  await buildValueMap(collectionFilter, selectedLocalIds, selectedLibraryKeys);

  // Determine which nodes to scan
  let roots: SceneNode[];
  if (scope === "selection") {
    roots = figma.currentPage.selection.length > 0
      ? [...figma.currentPage.selection]
      : [...figma.currentPage.children]; // Fall back to page if nothing selected
    log(
      "info",
      figma.currentPage.selection.length > 0
        ? `Scanning ${roots.length} selected node(s)`
        : "Nothing selected — scanning full page"
    );
  } else {
    roots = [...figma.currentPage.children];
    log("info", `Scanning full page (${roots.length} top-level node(s))`);
  }

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
  scope?: "selection" | "page";
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
    const scope = msg.scope ?? "page";
    const selectedLocalIds = msg.selectedLocalIds ?? [];
    const selectedLibraryKeys = msg.selectedLibraryKeys ?? [];

    try {
      const findings = await runScan(filter, scope, selectedLocalIds, selectedLibraryKeys);
      figma.ui.postMessage({ type: "scan-results", findings });
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
