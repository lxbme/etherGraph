import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import type { NftMetaDto } from "../../api/generated/NftMetaDto";
import { useJobProgress } from "../../shell/statusStore";
import { NftPreview, safeImageUrl } from "./NftPreview";

/** A synthetic NFT contract. */
const TOKEN = "0x" + "a7".repeat(20);

const ready = (o: Partial<NftMetaDto> = {}): NftMetaDto => ({
  status: "ready", name: "Synthetic #1", description: "A plain description", image: "ipfs://QmSynthetic/1.png",
  attributes: [{ trait_type: "Level", value: "5" }, { trait_type: null, value: "untyped" }], job_id: null, ...o,
});

const empty = (status: NftMetaDto["status"], job_id: number | null = null): NftMetaDto => ({
  status, name: null, description: null, image: null, attributes: [], job_id,
});

function renderPreview(tokenId = "1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (id: string) => (
    <QueryClientProvider client={qc}>
      <NftPreview address={TOKEN} tokenId={id} />
    </QueryClientProvider>
  );
  const r = render(ui(tokenId));
  return { ...r, rerenderId: (id: string) => r.rerender(ui(id)) };
}

beforeEach(() => useJobProgress.setState({ byId: {} }));
afterEach(() => vi.restoreAllMocks());

describe("safeImageUrl", () => {
  test.each([
    ["https://img.example.org/1.png", "https://img.example.org/1.png"],
    ["http://img.example.org/1.png", "http://img.example.org/1.png"],
    ["http://172.15.0.1/x.png", "http://172.15.0.1/x.png"],
    ["ipfs://QmSynthetic/1.png", "https://ipfs.io/ipfs/QmSynthetic/1.png"],
    ["ipfs://ipfs/QmSynthetic/1.png", "https://ipfs.io/ipfs/QmSynthetic/1.png"],
    ["data:image/png;base64,iVBORw0KGgo=", "data:image/png;base64,iVBORw0KGgo="],
    ["data:image/jpeg;base64,/9j/4AAQ", "data:image/jpeg;base64,/9j/4AAQ"],
    ["data:image/gif;base64,R0lGOD", "data:image/gif;base64,R0lGOD"],
    ["data:image/webp;base64,UklGR", "data:image/webp;base64,UklGR"],
    ["data:image/svg+xml,%3Csvg%2F%3E", "data:image/svg+xml,%3Csvg%2F%3E"],
  ])("%s is allowed as %s", (raw, safe) => {
    expect(safeImageUrl(raw)).toBe(safe);
  });

  test.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "file:///etc/passwd",
    "ftp://img.example.org/1.png",
    "data:text/html,<script>alert(1)</script>",
    "data:image/bmp;base64,Qk0=",
    "data:image/png",
    "http://127.0.0.1/x.png",
    "http://127.1.2.3/x.png",
    "http://2130706433/x.png",
    "http://localhost/x.png",
    "http://img.localhost:8080/x.png",
    "http://0.0.0.0/x.png",
    "http://10.1.2.3/x.png",
    "http://172.16.0.1/x.png",
    "http://172.31.255.255/x.png",
    "http://192.168.1.2/x.png",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/x.png",
    "http://[::1]/x.png",
    "http://[fe80::1]/x.png",
    "http://[fd00::1]/x.png",
    "http://[::ffff:127.0.0.1]/x.png",
    "https://127.0.0.1/x.png",
    "//img.example.org/1.png",
    "/x.png",
    "ipfs://",
    "not a url",
    "",
  ])("%j gives null", (raw) => {
    expect(safeImageUrl(raw)).toBeNull();
  });

  test("null gives null", () => {
    expect(safeImageUrl(null)).toBeNull();
  });
});

test("no request for the image before the click", async () => {
  vi.spyOn(api, "nft").mockResolvedValue(ready());
  const { container } = renderPreview();
  expect(await screen.findByText("Synthetic #1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Load image" })).toBeInTheDocument();
  expect(container.querySelector("img")).toBeNull();
});

test("after the click the img has the safe src and no-referrer", async () => {
  vi.spyOn(api, "nft").mockResolvedValue(ready());
  renderPreview();
  fireEvent.click(await screen.findByRole("button", { name: "Load image" }));
  const img = screen.getByRole("img", { name: "Synthetic #1" });
  expect(img).toHaveAttribute("src", "https://ipfs.io/ipfs/QmSynthetic/1.png");
  expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(img).toHaveAttribute("loading", "lazy");
  expect(screen.queryByRole("button", { name: "Load image" })).toBeNull();
});

test("the click is per token id", async () => {
  vi.spyOn(api, "nft").mockResolvedValue(ready());
  const { container, rerenderId } = renderPreview("1");
  fireEvent.click(await screen.findByRole("button", { name: "Load image" }));
  expect(container.querySelector("img")).not.toBeNull();
  rerenderId("2");
  expect(await screen.findByRole("button", { name: "Load image" })).toBeInTheDocument();
  expect(container.querySelector("img")).toBeNull();
});

test("description with <b> renders as text", async () => {
  vi.spyOn(api, "nft").mockResolvedValue(ready({ description: "A <b>bold</b>\nclaim" }));
  const { container } = renderPreview();
  const desc = await screen.findByText((_, el) => el?.textContent === "A <b>bold</b>\nclaim" && el.tagName === "P");
  expect(desc).toHaveClass("nft__description");
  expect(container.querySelector("b")).toBeNull();
});

test("attributes are a two-column list; a missing trait type shows a dash", async () => {
  vi.spyOn(api, "nft").mockResolvedValue(ready());
  renderPreview();
  const list = await screen.findByTestId("nft-attributes");
  expect([...list.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Level", "—"]);
  expect([...list.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["5", "untyped"]);
  expect(screen.getByText("Attributes")).toBeInTheDocument();
});

test("unsafe image: no button", async () => {
  vi.spyOn(api, "nft").mockResolvedValue(ready({ image: "javascript:alert(1)" }));
  const { container } = renderPreview();
  expect(await screen.findByText("Synthetic #1")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load image" })).toBeNull();
  expect(container.querySelector("img")).toBeNull();
});

test("pending shows loading; not_found shows no metadata", async () => {
  const spy = vi.spyOn(api, "nft").mockResolvedValue(empty("pending", 9));
  renderPreview();
  expect(await screen.findByText("Loading…")).toBeInTheDocument();
  expect(spy).toHaveBeenCalledWith(TOKEN, "1");

  spy.mockResolvedValue(empty("not_found"));
  renderPreview("2");
  expect(await screen.findByText("No metadata")).toBeInTheDocument();
});

test("ready without any field shows no metadata", async () => {
  vi.spyOn(api, "nft").mockResolvedValue({ ...empty("ready") });
  renderPreview();
  expect(await screen.findByText("No metadata")).toBeInTheDocument();
});

test("an error shows the message and Retry refetches", async () => {
  const spy = vi.spyOn(api, "nft").mockRejectedValueOnce(new ApiError("internal", 500, "boom"));
  spy.mockResolvedValueOnce(ready());
  renderPreview();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Synthetic #1")).toBeInTheDocument();
});

test("a failed fetch job shows its error and Retry asks again", async () => {
  const spy = vi.spyOn(api, "nft").mockResolvedValueOnce(empty("pending", 9));
  renderPreview();
  expect(await screen.findByText("Loading…")).toBeInTheDocument();
  useJobProgress.getState().upsert({
    type: "JobProgress", job_id: 9, kind: "fetch_nft", fetched: 0, cursor_block: null, status: "failed", error: "http 400",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("http 400");
  spy.mockResolvedValueOnce(ready());
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Synthetic #1")).toBeInTheDocument();
  expect(useJobProgress.getState().byId[9]).toBeUndefined();
});
