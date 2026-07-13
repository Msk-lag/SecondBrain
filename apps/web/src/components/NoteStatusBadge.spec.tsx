import { render, screen } from "@testing-library/react";
import { NoteStatusBadge } from "./NoteStatusBadge";

describe("NoteStatusBadge", () => {
  it("completed のときは何も表示しない", () => {
    const { container } = render(<NoteStatusBadge status="completed" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("pending のときは処理中バッジを表示する", () => {
    render(<NoteStatusBadge status="pending" />);
    expect(screen.getByText("処理中")).toBeInTheDocument();
  });

  it("processing のときは処理中バッジを表示する", () => {
    render(<NoteStatusBadge status="processing" />);
    expect(screen.getByText("処理中")).toBeInTheDocument();
  });

  it("failed のときは処理失敗バッジを表示する", () => {
    render(<NoteStatusBadge status="failed" />);
    expect(screen.getByText("処理に失敗しました")).toBeInTheDocument();
  });
});
