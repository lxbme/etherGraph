// Stubs replaced by later tasks (swap the imports in App.tsx).
export function AddressGraph() {
  return <div className="placeholder">关系图画布</div>;
}
export function TransferTable() {
  return <div className="placeholder">转账明细</div>;
}
export function DetailPanel() {
  return <div className="placeholder">节点详情</div>;
}
export function TxView({ hash }: { hash: string }) {
  return <div className="placeholder">交易 {hash.slice(0, 6)}…{hash.slice(-4)}</div>;
}
