import { QUICK_ACTIONS, QuickActionItem } from "../QuickActions";

describe("QuickActions component definitions", () => {
  it("defines the four primary quick actions", () => {
    expect(QUICK_ACTIONS).toHaveLength(4);
    const actionIds = QUICK_ACTIONS.map((a: QuickActionItem) => a.id);
    expect(actionIds).toEqual(["send", "receive", "swap", "buy"]);
  });

  it("links each quick action to the correct target route", () => {
    const routeMap = QUICK_ACTIONS.reduce<Record<string, string>>((acc, action) => {
      acc[action.id] = action.route as string;
      return acc;
    }, {});

    expect(routeMap).toEqual({
      send: "/send",
      receive: "/receive",
      swap: "/swap",
      buy: "/buy",
    });
  });

  it("provides non-empty labels, icon symbols, and accessibility labels for each action", () => {
    QUICK_ACTIONS.forEach((action) => {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.iconSymbol.length).toBeGreaterThan(0);
      expect(action.accessibilityLabel.length).toBeGreaterThan(0);
    });
  });
});
