export interface RefitDeps {
  /** Current container size in CSS pixels. */
  size(): { width: number; height: number };
  resize(): void;
  fit(): void;
}

/**
 * A layout that runs while the container is `display:none` fits to a 0x0 viewport. This remembers that
 * and refits once the container gets a size. Otherwise an ordinary resize or show keeps the viewport,
 * unless `fitOnResize` is set (whole-graph layouts such as the tx flow), in which case every resize
 * refits. Either way, once the user panned/zoomed after the last layout or fit, the viewport is theirs.
 */
export function createRefitGuard(deps: RefitDeps, opts: { fitOnResize?: boolean } = {}) {
  let laidOutWhileHidden = false;
  let userMoved = false;
  const hidden = () => {
    const { width, height } = deps.size();
    return !(width > 0 && height > 0);
  };
  return {
    /** Call after every layout (or fit) that was run. */
    noteLayout(): void {
      userMoved = false;
      if (hidden()) laidOutWhileHidden = true;
    },
    /** Call on user pan/zoom gestures. */
    noteUserViewport(): void {
      userMoved = true;
    },
    /** Call from the ResizeObserver. */
    onResize(): void {
      if (hidden()) return;
      deps.resize();
      if (!laidOutWhileHidden && !opts.fitOnResize) return;
      laidOutWhileHidden = false;
      if (!userMoved) deps.fit();
    },
  };
}
