/* Draggable divider between the timing table (left) and the track map (right).
   Dragging it changes the left pane's width via the --left-width CSS variable on
   the main layout, so dragging right shrinks the map and dragging left enlarges
   it. The width is NOT saved: every page load starts at the default 50/50 split,
   and dragging only changes the split for the current session. */

// Keep both panes usable: the left pane never gets narrower than this, and the
// right pane (the map) always keeps at least this much room.
const LAYOUT_MIN_LEFT_PX = 240;
const LAYOUT_MIN_RIGHT_PX = 320;
const LAYOUT_DIVIDER_PX = 6; // must match the divider column width in the CSS

// True while the user is actively dragging the divider.
let isDraggingDivider = false;

/* Apply a left-pane width (in pixels) to the layout, after clamping it so both
   panes stay within their minimum sizes for the current window width. */
function applyLayoutLeftWidth(widthPx) {
  const layout = document.querySelector(".main-layout");
  if (!layout) {
    return;
  }

  const totalWidth = layout.clientWidth;
  const maxLeft = totalWidth - LAYOUT_DIVIDER_PX - LAYOUT_MIN_RIGHT_PX;

  let clampedWidth = widthPx;
  if (clampedWidth < LAYOUT_MIN_LEFT_PX) {
    clampedWidth = LAYOUT_MIN_LEFT_PX;
  }
  if (clampedWidth > maxLeft) {
    clampedWidth = maxLeft;
  }

  layout.style.setProperty("--left-width", clampedWidth + "px");
  return clampedWidth;
}

/* Resize the left pane so it just fits the currently visible table columns, then
   move the divider to match. Called when a column is shown or hidden (see the
   column-settings panel) so adding a column grows the left pane and removing one
   shrinks it, fitting them all on the left. The width is still clamped so the
   map keeps its minimum size; if the columns need more room than that, the table
   simply scrolls. This does NOT run on page load, so a refresh stays 50/50. */
function autoFitLayoutToColumns() {
  const table = document.querySelector(".timing-table");
  if (!table) {
    return;
  }

  // Measure the table's natural width: the width it wants when it is sized to its
  // content instead of stretched to fill the pane. We briefly switch it to
  // size-to-content, read the width, then put the style back.
  const previousWidth = table.style.width;
  table.style.width = "max-content";
  const naturalTableWidth = table.offsetWidth;
  table.style.width = previousWidth;

  // A little extra room for the scrollbar and cell spacing so the last column is
  // never clipped right at the edge.
  const extraRoom = 18;
  applyLayoutLeftWidth(naturalTableWidth + extraRoom);
}

/* Work out the left-pane width from the mouse position and apply it. The left
   pane starts at the layout's left edge, so its width is simply how far the
   pointer is from that edge. */
function resizeFromPointer(clientX) {
  const layout = document.querySelector(".main-layout");
  if (!layout) {
    return;
  }
  const layoutRect = layout.getBoundingClientRect();
  const widthPx = clientX - layoutRect.left;
  applyLayoutLeftWidth(widthPx);
}

function onDividerPointerMove(event) {
  if (!isDraggingDivider) {
    return;
  }
  resizeFromPointer(event.clientX);
}

function onDividerPointerUp() {
  if (!isDraggingDivider) {
    return;
  }
  isDraggingDivider = false;

  const divider = document.getElementById("layoutDivider");
  if (divider) {
    divider.classList.remove("dragging");
  }
  document.body.classList.remove("layout-resizing");
}

function onDividerPointerDown(event) {
  isDraggingDivider = true;

  const divider = document.getElementById("layoutDivider");
  if (divider) {
    divider.classList.add("dragging");
  }
  document.body.classList.add("layout-resizing");

  // Resize once straight away so a click without movement still snaps the edge
  // to the pointer.
  resizeFromPointer(event.clientX);
  event.preventDefault();
}

/* Wire up the divider. Called once at startup. The split is left at its default
   50/50 (no saved width is restored), so a hard refresh always starts centred. */
function initializeLayoutDivider() {
  const divider = document.getElementById("layoutDivider");
  if (!divider) {
    return;
  }

  divider.addEventListener("pointerdown", onDividerPointerDown);
  // Listen on the whole document so the drag keeps working even if the pointer
  // moves off the thin divider while dragging.
  document.addEventListener("pointermove", onDividerPointerMove);
  document.addEventListener("pointerup", onDividerPointerUp);

  // If the window is resized, re-clamp the saved width so a pane cannot end up
  // smaller than its minimum on a now-narrower window.
  window.addEventListener("resize", function () {
    const layout = document.querySelector(".main-layout");
    if (!layout) {
      return;
    }
    const currentWidth = layout.style.getPropertyValue("--left-width");
    const widthPx = parseInt(currentWidth, 10);
    if (!isNaN(widthPx)) {
      applyLayoutLeftWidth(widthPx);
    }
  });
}
