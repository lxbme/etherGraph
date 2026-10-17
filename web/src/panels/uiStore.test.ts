import { useGraph } from "../graph/store";
import { useUi } from "./uiStore";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const H = "0x" + "11".repeat(32);

function stubNarrow(narrow: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: narrow && q.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  useGraph.getState().reset();
  useUi.setState({ labelEditorFor: null, detailOpen: true, txSelection: {} });
});
afterEach(() => vi.unstubAllGlobals());

test("a pending label editor request is cleared when the selection changes, not on a re-select", () => {
  useGraph.getState().select({ kind: "node", address: A });
  useUi.getState().openLabelEditor(A);
  useGraph.getState().select({ kind: "node", address: A });
  expect(useUi.getState().labelEditorFor).toBe(A);
  useGraph.getState().select({ kind: "node", address: B });
  expect(useUi.getState().labelEditorFor).toBeNull();
  useUi.getState().openLabelEditor(B);
  useGraph.getState().select(null);
  expect(useUi.getState().labelEditorFor).toBeNull();
});

test("openLabelEditor opens the detail panel", () => {
  useUi.setState({ detailOpen: false });
  useUi.getState().openLabelEditor(A.toUpperCase().replace("0X", "0x"));
  expect(useUi.getState()).toMatchObject({ labelEditorFor: A, detailOpen: true });
});

test("toggleDetail flips the panel", () => {
  useUi.getState().toggleDetail();
  expect(useUi.getState().detailOpen).toBe(false);
  useUi.getState().toggleDetail();
  expect(useUi.getState().detailOpen).toBe(true);
});

test("under 900px selecting a node opens the detail overlay; wide screens keep the user's choice", () => {
  stubNarrow(true);
  useUi.setState({ detailOpen: false });
  useGraph.getState().select({ kind: "node", address: A });
  expect(useUi.getState().detailOpen).toBe(true);

  stubNarrow(false);
  useUi.setState({ detailOpen: false });
  useGraph.getState().select({ kind: "node", address: B });
  expect(useUi.getState().detailOpen).toBe(false);
});

test("under 900px selecting a transaction (its summary card) opens the overlay too; a pair does not", () => {
  stubNarrow(true);
  useUi.setState({ detailOpen: false });
  useGraph.getState().select({ kind: "tx", hash: H, context: { kind: "node", address: A } });
  expect(useUi.getState().detailOpen).toBe(true);

  useUi.setState({ detailOpen: false });
  useGraph.getState().select({ kind: "pair", a: A, b: B });
  expect(useUi.getState().detailOpen).toBe(false);
});

test("tx tabs keep their own selection; changing it clears the editor and opens the overlay when narrow", () => {
  stubNarrow(true);
  useUi.setState({ detailOpen: false });
  useUi.getState().selectTx(H, A);
  expect(useUi.getState().txSelection[H]).toBe(A);
  expect(useUi.getState().detailOpen).toBe(true);
  useUi.getState().openLabelEditor(A);
  useUi.getState().selectTx(H, B);
  expect(useUi.getState().labelEditorFor).toBeNull();
  useUi.getState().forgetTx(H);
  expect(H in useUi.getState().txSelection).toBe(false);
});
