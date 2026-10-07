const LAYOUT_MIN_LEFT_PX = 240;
const LAYOUT_MIN_RIGHT_PX = 320;
const LAYOUT_DIVIDER_PX = 6;

let isDraggingDivider = false;
let dividerPointerId = null;

function layoutWidthLimits(totalWidth) {
  const availableWidth = Math.max(0, totalWidth - LAYOUT_DIVIDER_PX);
  const minimum = Math.min(LAYOUT_MIN_LEFT_PX, availableWidth * LAYOUT_MIN_LEFT_PX / (LAYOUT_MIN_LEFT_PX + LAYOUT_MIN_RIGHT_PX));
  return { minimum, maximum: Math.max(minimum, availableWidth - LAYOUT_MIN_RIGHT_PX) };
}

function updateDividerAccessibility(width, limits) {
  const divider = document.getElementById('layoutDivider');
  if (!divider) return;
  divider.setAttribute('aria-valuemin', Math.round(limits.minimum));
  divider.setAttribute('aria-valuemax', Math.round(limits.maximum));
  divider.setAttribute('aria-valuenow', Math.round(width));
  divider.setAttribute('aria-valuetext', 'Timing panel ' + Math.round(width) + ' pixels wide');
}

function applyLayoutLeftWidth(widthPx) {
  const layout = document.querySelector(".main-layout");
  if (!layout) {
    return;
  }

  const totalWidth = layout.clientWidth;
  const limits = layoutWidthLimits(totalWidth);

  let clampedWidth = widthPx;
  if (clampedWidth < limits.minimum) {
    clampedWidth = limits.minimum;
  }
  if (clampedWidth > limits.maximum) {
    clampedWidth = limits.maximum;
  }

  layout.style.setProperty("--left-width", clampedWidth + "px");
  updateDividerAccessibility(clampedWidth, limits);
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

  const header = document.querySelector('.section-title');
  let headerWidth = 0;
  if (header) {
    const previousHeaderWidth = header.style.width;
    header.style.width = 'max-content';
    headerWidth = header.offsetWidth;
    header.style.width = previousHeaderWidth;
  }

  const extraRoom = 18;
  applyLayoutLeftWidth(Math.max(naturalTableWidth + extraRoom, headerWidth));
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
  if (dividerPointerId !== null && event.pointerId !== dividerPointerId) return;
  resizeFromPointer(event.clientX);
}

function onDividerPointerUp(event) {
  if (!isDraggingDivider) {
    return;
  }
  if (dividerPointerId !== null && event && event.pointerId !== undefined && event.pointerId !== dividerPointerId) return;
  isDraggingDivider = false;

  const divider = document.getElementById("layoutDivider");
  if (divider) {
    divider.classList.remove("dragging");
    if (dividerPointerId !== null && divider.hasPointerCapture && divider.hasPointerCapture(dividerPointerId)) {
      divider.releasePointerCapture(dividerPointerId);
    }
  }
  dividerPointerId = null;
  document.body.classList.remove("layout-resizing");
}

function onDividerPointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if (isDraggingDivider) return;
  isDraggingDivider = true;

  const divider = document.getElementById("layoutDivider");
  if (divider) {
    divider.classList.add("dragging");
    if (divider.setPointerCapture && event.pointerId !== undefined) {
      dividerPointerId = event.pointerId;
      divider.setPointerCapture(event.pointerId);
    }
  }
  document.body.classList.add("layout-resizing");

  resizeFromPointer(event.clientX);
  event.preventDefault();
}

function onDividerKeyDown(event) {
  const layout = document.querySelector('.main-layout');
  if (!layout) return;
  const limits = layoutWidthLimits(layout.clientWidth);
  const currentWidth = document.querySelector('.timing-area').getBoundingClientRect().width;
  const step = event.shiftKey ? 50 : 10;
  let width;
  if (event.key === 'ArrowLeft') width = currentWidth - step;
  else if (event.key === 'ArrowRight') width = currentWidth + step;
  else if (event.key === 'Home') width = limits.minimum;
  else if (event.key === 'End') width = limits.maximum;
  else return;
  applyLayoutLeftWidth(width);
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
  document.addEventListener("pointercancel", onDividerPointerUp);
  divider.addEventListener('lostpointercapture', onDividerPointerUp);
  window.addEventListener("blur", onDividerPointerUp);
  divider.addEventListener('keydown', onDividerKeyDown);
  const layout = document.querySelector('.main-layout');
  if (layout) {
    updateDividerAccessibility(document.querySelector('.timing-area').getBoundingClientRect().width, layoutWidthLimits(layout.clientWidth));
  }

  window.addEventListener("resize", function () {
    const layout = document.querySelector(".main-layout");
    if (!layout) {
      return;
    }
    const currentWidth = layout.style.getPropertyValue("--left-width");
    const widthPx = parseInt(currentWidth, 10);
    if (!isNaN(widthPx)) {
      applyLayoutLeftWidth(widthPx);
    } else {
      updateDividerAccessibility(document.querySelector('.timing-area').getBoundingClientRect().width, layoutWidthLimits(layout.clientWidth));
    }
  });
}
