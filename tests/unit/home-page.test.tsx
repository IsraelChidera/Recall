import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import HomePage from "@/app/page";

it("renders the tagline and the three steps", () => {
  render(<HomePage />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/Recall makes sure/);
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
});
