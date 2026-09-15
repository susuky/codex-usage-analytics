import { describe, expect, it } from "vitest";
import { cacheRate, formatCost, formatSessionCost, formatTokens, shortId } from "./format";

describe("usage formatting", () => {
  it("formats token magnitudes for a dense dashboard", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_450)).toBe("12.4K");
    expect(formatTokens(1_250_000)).toBe("1.25M");
  });

  it("labels unknown prices instead of inventing a model mapping", () => {
    expect(formatCost(null)).toBe("無法估算");
    expect(formatCost(1_320_000)).toBe("US$1.32");
    expect(formatSessionCost(1_320_000, 100_000, 1)).toBe("US$1.32（部分）");
    expect(formatSessionCost(0, 0, 0)).toBe("無使用量");
  });

  it("computes safe cache rates and redacts long ids", () => {
    expect(cacheRate({ inputTokens: 1_000, cachedInputTokens: 750 })).toBe(75);
    expect(cacheRate({ inputTokens: 0, cachedInputTokens: 0 })).toBe(0);
    expect(shortId("1234567890abcdefghijklmnop")).toBe("12345678…klmnop");
  });
});
