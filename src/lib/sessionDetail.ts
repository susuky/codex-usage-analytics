import type { TurnUsage } from "../types";

export function buildSessionTimeline(turns: TurnUsage[]) {
  const timedTurns = turns.map(turn => ({ turn, timestamp: Date.parse(turn.timestamp) }))
    .filter(item => Number.isFinite(item.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp || a.turn.ordinal - b.turn.ordinal);
  let total = 0, input = 0, output = 0, reasoning = 0;
  return timedTurns.map(({ turn, timestamp }) => {
    total += turn.tokens.totalTokens;
    input += turn.tokens.inputTokens;
    output += turn.tokens.outputTokens;
    reasoning += turn.tokens.reasoningOutputTokens;
    return { timestamp, ordinal: turn.ordinal, model: turn.model, total, input, output, reasoning };
  });
}

export function sessionTimeAxisFormat(start: number, end: number) {
  const first = new Date(start), last = new Date(end);
  const sameDay = first.toDateString() === last.toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit", second: end - start < 300_000 ? "2-digit" : undefined, hour12: false }
    : { year: first.getFullYear() !== last.getFullYear() ? "numeric" : undefined, month: "2-digit", day: "2-digit", hour: end - start < 345_600_000 ? "2-digit" : undefined, minute: end - start < 345_600_000 ? "2-digit" : undefined, hour12: false };
  return new Intl.DateTimeFormat("zh-TW", options);
}

export const sessionTimestampFormat = new Intl.DateTimeFormat("zh-TW", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
