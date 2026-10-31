import { MobileAnalytics } from "./analytics-core";

/**
 * The product analytics of the mobile app. They are off in every build: the upstream OpenBot app sent
 * them, with the account ID and email, to an analytics service of the upstream project, which
 * Builders Bot does not control (phase 0 of `.openbot-build/bug-reports/DESIGN.md`). With no client
 * and no failure report queue, `MobileAnalytics` drops each event and sends nothing.
 */
export const mobileAnalytics = new MobileAnalytics(() => null);
