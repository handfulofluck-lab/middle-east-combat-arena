// Camera: pan (arrows / screen edge / middle-drag), wheel zoom clamped,
// world<->screen transforms. x,y = world coords shown at screen top-left.
export function createCamera(viewW, viewH) {
  return {
    x: 0, y: 0, zoom: 1,
    minZoom: 0.35, maxZoom: 2.5,
    viewW, viewH,
  };
}

export function screenToWorld(cam, sx, sy) {
  return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
}

export function worldToScreen(cam, wx, wy) {
  return { x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom };
}

// pan by screen-pixel delta
export function panCameraBy(cam, dxPx, dyPx) {
  cam.x += dxPx / cam.zoom;
  cam.y += dyPx / cam.zoom;
}

// zoom anchored at the cursor position
export function zoomCameraAt(cam, factor, sx, sy) {
  const nz = Math.max(cam.minZoom, Math.min(cam.maxZoom, cam.zoom * factor));
  if (!isFinite(nz) || nz <= 0 || nz === cam.zoom) return;
  const wx = sx / cam.zoom + cam.x;
  const wy = sy / cam.zoom + cam.y;
  cam.zoom = nz;
  cam.x = wx - sx / nz;
  cam.y = wy - sy / nz;
  if (!isFinite(cam.x) || !isFinite(cam.y)) { cam.x = wx; cam.y = wy; }
}

export function clampCameraToMap(cam, worldW, worldH) {
  const vw = cam.viewW / cam.zoom;
  const vh = cam.viewH / cam.zoom;
  const mx = Math.max(0, worldW - vw);
  const my = Math.max(0, worldH - vh);
  if (cam.x < 0) cam.x = 0;
  if (cam.y < 0) cam.y = 0;
  if (cam.x > mx) cam.x = mx;
  if (cam.y > my) cam.y = my;
}

export function centerCameraOn(cam, wx, wy) {
  cam.x = wx - cam.viewW / cam.zoom / 2;
  cam.y = wy - cam.viewH / cam.zoom / 2;
}
