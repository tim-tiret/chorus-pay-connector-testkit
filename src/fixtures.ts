import type { PayLinkDto, SupplierProfileDto } from "@chorus-pay/connector-sdk";

/** Pay link d'exemple, représentatif d'un devis accepté prêt à facturer. */
export function samplePayLink(overrides: Partial<PayLinkDto> = {}): PayLinkDto {
  return {
    id: "pl_testkit0000000000000000000000001",
    supplier_id: 4242,
    quote_number: "DEV-2026-0042",
    status: "accepted",
    amount: "120.00",
    amount_ht: "100.00",
    currency: "EUR",
    description: "Prestation de test",
    client_info: {
      name: "Mairie de Testville",
      siret: "21092064000016",
      email: "comptabilite@testville.fr",
      address: "1 place de la Mairie, 92000 Testville",
    },
    items: [
      {
        description: "Prestation de test",
        quantity: 2,
        unit_price: 50,
        vat_rate: 20,
        total: 100,
        reference: "PREST-01",
      },
    ],
    metadata: null,
    purchase_order_analysis: null,
    source: "manual",
    url: "pl_testkit0000000000000000000000001",
    shipping_address: null,
    scheduled_invoice_date: null,
    created_at: "2026-01-01T09:00:00.000Z",
    accepted_at: "2026-01-02T09:00:00.000Z",
    expires_at: "2026-02-01T09:00:00.000Z",
    ...overrides,
  };
}

/** Pay link d'exemple issu d'un panier boutique (source shopify_theme). */
export function sampleShopPayLink(overrides: Partial<PayLinkDto> = {}): PayLinkDto {
  return samplePayLink({
    id: "pl_testkit0000000000000000000000002",
    source: "shopify_theme",
    metadata: {
      cart_token: "cart_token_test_123",
      shopify_shop_url: "boutique-test.myshopify.com",
    },
    ...overrides,
  });
}

export function sampleSupplierProfile(supplierId = 4242): SupplierProfileDto {
  return {
    id: supplierId,
    name: "Fournisseur Test SARL",
    trade_name: "FournisseurTest",
    siret: "12345678900012",
    email: "contact@fournisseur-test.fr",
  };
}

/** PDF minimal valide pour les fixtures de téléchargement. */
export function samplePdf(): Buffer {
  return Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");
}
