import { useEffect } from "react";
import { useGraph } from "../../graph/store";
import { useGraphData } from "../../graph/useGraphData";
import { PickNeighboursDialog } from "./PickNeighboursDialog";
import { usePick } from "./pickStore";

/** Shows the neighbour picker while `usePick` has targets; a fresh dialog per open. */
export function PickHost() {
  const targets = usePick((s) => s.targets);
  const close = usePick((s) => s.close);
  const frozen = useGraph((s) => !!s.frozen);
  // A snapshot loaded while the picker is open: its live lists no longer apply.
  useEffect(() => {
    if (frozen && targets) close();
  }, [frozen, targets, close]);
  if (!targets || frozen) return null;
  return <OpenPicker key={targets.join(",")} targets={targets} onClose={close} />;
}

/** The dialog with the canvas it picks for (subscribed to the graph only while open). */
function OpenPicker({ targets, onClose }: { targets: string[]; onClose(): void }) {
  const { data } = useGraphData();
  return <PickNeighboursDialog targets={targets} data={data} onClose={onClose} />;
}
