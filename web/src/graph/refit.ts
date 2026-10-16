export interface RefitDeps {
  /** Current container size in CSS pixels. */
  size(): { width: number; height: number };
  resize(): void;
  fit(): void;
}

/**
 * A layout that runs while the container is `display:none` fits to a 0x0 viewport. This remembers that
 * and refits once the container gets a size — but never otherwise, so an ordinary resize or show keeps
 * the user's viewport. If the user panned/zoomed in the meantime the viewport is theirs and is kept.
 */
export function createRefitGuard(deps: RefitDeps) {
  let laidOutWhileHidden = false;
  let userMoved = false;
  const hidden = () => {
    const { width, height } = deps.size();
    return !(width > 0 && height > 0);
  };
  return {
    /** Call after every layout (or fit) that was run. */
    noteLayout(): void {
      if (hidden()) {
        laidOutWhileHidden = true;
        userMoved = false;
      }
    },
    /** Call on user pan/zoom gestures. */
    noteUserViewport(): void {
      userMoved = true;
    },
    /** Call from the ResizeObserver. */
    onResize(): void {
      if (hidden()) return;
      deps.resize();
      if (!laidOutWhileHidden) return;
      laidOutWhileHidden = false;
      if (!userMoved) deps.fit();
    },
  };
}
