/* Shared source of truth for four-cycle GFS comparison charts. */
(function (root) {
  "use strict";
  const colors = Object.freeze([
    "#b38be8", // newest: lilac
    "#f1c98b", // previous: yellow
    "#8abce8", // two cycles back: blue
    "#7dd3d7"  // three cycles back: green
  ]);
  const theme = Object.freeze({
    colors,
    latestStrokeWidth: 5,
    previousStrokeWidth: 1.8,
    previousStrokeDasharray: "5 4"
  });
  Object.defineProperty(root, "GFS_CYCLE_THEME", {
    value: theme,
    writable: false,
    configurable: false
  });
})(window);
