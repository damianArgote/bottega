/** Fictitious demo businesses the user can pick (content/demos/<scenario>.json). */
export const DEMO_SCENARIOS = ['insurance', 'barbershop'] as const;

export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

/**
 * Scenario of a DEMO context created before contexts stored one
 * (ConversationContext.demoScenario null).
 */
export const LEGACY_DEMO_SCENARIO: DemoScenario = 'barbershop';

export function isDemoScenario(value: unknown): value is DemoScenario {
  return (DEMO_SCENARIOS as readonly unknown[]).includes(value);
}

/** The stored scenario of a context, with the legacy fallback. */
export function demoScenarioOf(stored: string | null): DemoScenario {
  return isDemoScenario(stored) ? stored : LEGACY_DEMO_SCENARIO;
}
