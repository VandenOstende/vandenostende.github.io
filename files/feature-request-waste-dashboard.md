# Feature Request — Movable POI Markers on Waste Dashboard

## Summary
Make POI (Point of Interest) markers movable on the waste dashboard map. Users should be able to adjust a marker's position while editing a POI.

## Motivation
Currently POI markers are fixed after placement. Allowing users to move markers fixes incorrect placements quickly without recreating POIs and improves data accuracy for reporting and routing.

## Proposed behavior
- When a user double-clicks a POI to edit it, the POI popup opens in edit mode.
- The popup contains an explicit "Move marker" button.
- When the user clicks "Move marker":
  - The map enters a simple move mode where the selected marker can be dragged to a new location.
  - Alternatively (if dragging is not feasible), the user can click on the map to set the marker's new position.
  - A visual hint appears (example: marker changes color or shows a drag handle) so the user knows the marker is movable.
- After placing the marker in the new position, the popup should display a confirmation action: "Save position" and a cancel option: "Cancel".
- On save, the POI's coordinates are updated and persisted to the backend.
- On cancel, the marker returns to its original coordinates.

## UI details
- Button label: "Move marker" (or localized equivalent)
- Tooltip: "Drag marker to new location, then click Save position"
- Visual feedback: marker shadow / outline / color change while moving

## Edge cases & validation
- If the user attempts to save without actually moving the marker, treat as a no-op (but still allow Save).
- If backend persistence fails, show an error toast and revert the marker to the previous position.
- Respect map zoom and map bounds when placing the marker.

## Acceptance criteria
- [ ] Double-clicking a POI opens edit mode with a "Move marker" button in the popup
- [ ] Clicking "Move marker" allows the marker to be repositioned by dragging or map click
- [ ] User can Save or Cancel the new position
- [ ] Successful save updates backend coordinates; failures produce a clear error message

## Notes for implementation
- If the map library already supports marker dragging (e.g., Leaflet: marker.dragging.enable()), prefer enabling built-in dragging for best UX.
- Keep the UI accessible: keyboard support where feasible and clear focus states.

## Original request (translated)
"Allow moving POI markers. This should be possible via a button in the popup while editing (after double-click)."

---

Author: @VandenOstende
