const KIOSK_CURSOR_IDLE_MS = 3000;

// ?kiosk=1 turns the dashboard into a read-only event screen (styles live
// under body.kiosk in display.css). ?cycle=N alternates the existing split
// layout between a leaderboard-focused and a map-focused view every N seconds.
function initializeKioskMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("kiosk") !== "1") {
    return;
  }
  document.body.classList.add("kiosk");

  let idleTimer = null;
  function wakeCursor() {
    document.body.classList.remove("kiosk-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      document.body.classList.add("kiosk-idle");
    }, KIOSK_CURSOR_IDLE_MS);
  }
  document.addEventListener("mousemove", wakeCursor);
  wakeCursor();

  const cycleSeconds = parseInt(params.get("cycle"), 10);
  if (!(cycleSeconds > 0)) {
    return;
  }
  let showMap = false;
  function showNextView() {
    // applyLayoutLeftWidth clamps these to the divider's min/max widths.
    applyLayoutLeftWidth(showMap ? 0 : Infinity);
    showMap = !showMap;
  }
  showNextView();
  setInterval(showNextView, cycleSeconds * 1000);
}
