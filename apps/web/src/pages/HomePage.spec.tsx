import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { HomePage } from "./HomePage";
import { apiClient } from "../lib/api-client";

vi.mock("../lib/api-client", () => ({
  apiClient: {
    getHealth: vi.fn(),
  },
}));

describe("HomePage", () => {
  it("shows the API health status once the query resolves", async () => {
    vi.mocked(apiClient.getHealth).mockResolvedValue({
      status: 200,
      body: { status: "ok" },
      headers: new Headers(),
    });

    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("health-status")).toHaveTextContent("ok"));
  });
});
