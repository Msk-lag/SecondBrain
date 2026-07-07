import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/api-client";
import { useCounterStore } from "../store/useCounterStore";

export function HomePage() {
  const { count, increment } = useCounterStore();
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const response = await apiClient.getHealth();
      if (response.status !== 200) {
        throw new Error(`unexpected health response status: ${response.status}`);
      }
      return response.body;
    },
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-3xl font-semibold">SecondBrain</h1>
      <p data-testid="health-status">
        API status:{" "}
        {healthQuery.isLoading ? "checking..." : (healthQuery.data?.status ?? "unreachable")}
      </p>
      <button
        type="button"
        onClick={increment}
        className="rounded bg-purple-600 px-4 py-2 text-white"
      >
        count is {count}
      </button>
    </main>
  );
}
