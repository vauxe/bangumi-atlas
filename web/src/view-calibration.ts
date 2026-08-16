/** Local explorer scale derived from the published geometry contract.
 *
 * The pixel targets preserve the established 0.28-unit release behavior, but
 * runtime zooms are always derived from the current release's declared node
 * center distance. Scaling published coordinates therefore cannot silently
 * move focus, labels, or deep-zoom cruise to a different visual distance. */

const FOCUS_CENTER_GAP_PX = 0.28 * 2 ** 6.2;
const NEARBY_CENTER_GAP_PX = FOCUS_CENTER_GAP_PX * 2 ** 1.3;
const CRUISE_CENTER_GAP_PX = FOCUS_CENTER_GAP_PX * 2 ** 3.8;

export interface ViewCalibration {
  readonly minimumCenterDistance: number;
  readonly focusZoom: number;
  readonly nearbyLabelZoom: number;
  readonly maxZoom: number;
  readonly worldUnitsPerFocusPixel: number;
}

const zoomForGap = (
  gapPixels: number,
  minimumCenterDistance: number,
): number => Math.log2(gapPixels / minimumCenterDistance);

export function viewCalibration(minimumCenterDistance: number): ViewCalibration {
  if (!Number.isFinite(minimumCenterDistance) || minimumCenterDistance <= 0)
    throw new TypeError("published center distance must be positive and finite");
  const focusZoom = zoomForGap(FOCUS_CENTER_GAP_PX, minimumCenterDistance);
  return {
    minimumCenterDistance,
    focusZoom,
    nearbyLabelZoom: zoomForGap(
      NEARBY_CENTER_GAP_PX,
      minimumCenterDistance,
    ),
    maxZoom: zoomForGap(CRUISE_CENTER_GAP_PX, minimumCenterDistance),
    worldUnitsPerFocusPixel: minimumCenterDistance / FOCUS_CENTER_GAP_PX,
  };
}

/** Convert a desired screen size at focus into deck common/world units. */
export function focusPixelsToWorldUnits(
  pixels: number,
  calibration: ViewCalibration,
): number {
  return pixels * calibration.worldUnitsPerFocusPixel;
}
