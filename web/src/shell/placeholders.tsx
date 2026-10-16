// Stubs replaced by later tasks (swap the imports in App.tsx).
export function TxView({ hash }: { hash: string }) {
  return <div className="placeholder">交易 {hash.slice(0, 6)}…{hash.slice(-4)}</div>;
}
