const LAYOUT_MIN_LEFT_PX = 240;
const LAYOUT_MIN_RIGHT_PX = 320;
const LAYOUT_DIVIDER_PX = 6;

let isDraggingDivider = false;

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

function autoFitLayoutToColumns() {
  const table = document.querySelector(".timing-table");
  if (!table) {
    return;
  }

  const previousWidth = table.style.width;
  table.style.width = "max-content";
  const naturalTableWidth = table.offsetWidth;
  table.style.width = previousWidth;

  const extraRoom = 18;
  applyLayoutLeftWidth(naturalTableWidth + extraRoom);
}

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

  resizeFromPointer(event.clientX);
  event.preventDefault();
}

function initializeLayoutDivider() {
  const divider = document.getElementById("layoutDivider");
  if (!divider) {
    return;
  }

  divider.addEventListener("pointerdown", onDividerPointerDown);
  document.addEventListener("pointermove", onDividerPointerMove);
  document.addEventListener("pointerup", onDividerPointerUp);

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
