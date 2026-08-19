const apiBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

type RequestOptions = {
  signal?: AbortSignal;
};

export async function apiGet<TResponse>(
  path: string,
  options: RequestOptions = {}
): Promise<TResponse> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }

  return response.json() as Promise<TResponse>;
}
