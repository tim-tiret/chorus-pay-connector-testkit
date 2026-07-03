# @chorus-pay/connector-testkit

Kit de conformité pour tester des **connecteurs Chorus Pay** sans base de
données ni réseau : mock du `ctx`, fixtures, et vérification automatique du
respect du protocole.

📖 Documentation : https://choruspay.fr/doc/connecteurs

## Installation

```bash
npm install -D @chorus-pay/connector-testkit
```

## Utilisation

```ts
import { runConformance, createMockCtx, samplePayLink } from "@chorus-pay/connector-testkit";
import connector from "./index";

// Conformité au protocole (manifest, contrats d'échec, isolation, arrondis…)
const report = await runConformance(connector);

// Tests métier avec un ctx simulé (HTTP scripté, kv/config en mémoire)
const { ctx, state } = createMockCtx({
  config: { apiKey: "test" },
  httpFixtures: [{ url: "/invoices", method: "POST", data: { id: 42 } }],
});
const result = await connector.capabilities.invoice.create(ctx, {
  payLink: samplePayLink(),
  payLinkId: samplePayLink().id,
  invoiceDate: "2026-01-01",
});
```

## Exports

- `runConformance(def)` → rapport de conformité
- `createMockCtx(options)` → `{ ctx, state, calls }`
- `samplePayLink`, `sampleShopPayLink`, `sampleSupplierProfile`, `samplePdf`
- `assertCentRounded(amount)`

## Licence

MIT.
