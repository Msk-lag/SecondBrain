export function getRedisConnectionOptions() {
  const rawPort = process.env.REDIS_PORT ?? "6379";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`REDIS_PORT must be a positive integer, got: ${rawPort}`);
  }

  return {
    host: process.env.REDIS_HOST ?? "localhost",
    port,
  };
}
