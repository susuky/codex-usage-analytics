export const formatTokens = (value: number) => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return new Intl.NumberFormat("zh-TW").format(value);
};

export const formatInteger = (value: number) => new Intl.NumberFormat("zh-TW").format(value);

export const formatCost = (microusd: number | null) =>
  microusd === null ? "無法估算" : `US$${(microusd / 1_000_000).toFixed(2)}`;

export const formatSessionCost = (microusd: number | null, totalTokens: number, unpricedTurnCount: number) => {
  if (totalTokens === 0) return "無使用量";
  if (microusd === null) return "無法估算";
  return unpricedTurnCount > 0 ? `${formatCost(microusd)}（部分）` : formatCost(microusd);
};

export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(iso));

export const formatDate = (iso: string) =>
  new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(new Date(iso));

export const cacheRate = (tokens: { inputTokens: number; cachedInputTokens: number }) =>
  tokens.inputTokens > 0 ? (tokens.cachedInputTokens / tokens.inputTokens) * 100 : 0;

export const shortId = (value: string) =>
  value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
