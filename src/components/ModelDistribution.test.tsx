import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { ModelDistribution } from "./ModelDistribution";
import { buildDemoOverview } from "../lib/mockData";

afterEach(cleanup);

it("sorts models without mutating the source and discloses every model", () => {
  const template = buildDemoOverview().models[0];
  const models = Array.from({ length: 8 }, (_, index) => ({ ...template, model: `model-${index}`, tokens: { ...template.tokens, totalTokens: (index + 1) * 100 } }));
  const { container } = render(<MemoryRouter><ModelDistribution models={models} total={3600} /></MemoryRouter>);
  expect(container.querySelectorAll("li")).toHaveLength(6);
  expect(container.querySelector("li")).toHaveTextContent("model-7");
  expect(models[0].model).toBe("model-0");
  fireEvent.click(screen.getByRole("button", { name: "顯示全部 8 個模型" }));
  expect(container.querySelectorAll("li")).toHaveLength(8);
  expect(screen.getByRole("button", { name: "收合模型" })).toHaveAttribute("aria-expanded", "true");
});

it("keeps tiny nonzero shares distinct from zero", () => {
  const model = buildDemoOverview().models[0];
  render(<MemoryRouter><ModelDistribution models={[{ ...model, tokens: { ...model.tokens, totalTokens: 1 } }]} total={1000000} /></MemoryRouter>);
  expect(screen.getByText("<0.1%")).toBeVisible();
  expect(screen.getByText("1 Tokens")).toBeVisible();
});

it("shows an explicit empty state without a misleading ranking", () => {
  render(<MemoryRouter><ModelDistribution models={[]} total={0} /></MemoryRouter>);
  expect(screen.getByText("此區間尚無模型用量")).toBeVisible();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
