/**
 * Chorus Pay Connector Testkit — kit de conformité au protocole de
 * connecteurs (doc/connectors/CONNECTOR_SPEC.md). Sans DB ni réseau.
 *
 * Usage : scripts/connector/test.mjs, ou en CI d'un repo de connecteur.
 */

export { createMockCtx } from "./mock-ctx";
export type { MockCtx, MockCtxOptions, HttpFixture, RecordedCall } from "./mock-ctx";
export {
  samplePayLink,
  sampleShopPayLink,
  sampleSupplierProfile,
  samplePdf,
} from "./fixtures";
export { runConformance, assertCentRounded } from "./conformance";
export type { ConformanceReport, ConformanceIssue } from "./conformance";
