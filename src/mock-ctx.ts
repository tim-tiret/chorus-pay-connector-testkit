import type {
  ConnectorCtx,
  ConnectorEventInput,
  ConnectorHttpRequest,
  ConnectorHttpResponse,
  CreatePayLinkDto,
  InvoiceDto,
  JsonObject,
  JsonValue,
  ManagedWebhook,
  PayLinkDto,
} from "@chorus-pay/connector-sdk";
import { ConnectorHttpError } from "@chorus-pay/connector-sdk";
import { samplePayLink, sampleSupplierProfile } from "./fixtures.js";

/**
 * Mock du ConnectorCtx pour le kit de conformité : kv/config/invoices en
 * mémoire, HTTP scripté par fixtures, tous les appels enregistrés.
 * Aucune dépendance à la DB ni au réseau — utilisable en CI d'un repo de
 * connecteur autonome.
 */

export interface HttpFixture {
  /** Match : méthode + regex/substring d'URL. */
  method?: string;
  url: string | RegExp;
  /** Réponse renvoyée (status 200 par défaut). */
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
  /** Ou : simule un échec réseau/HTTP (throw ConnectorHttpError). */
  error?: { status?: number; message?: string };
}

export interface RecordedCall {
  surface: string; // "http.fetch", "kv.set", "events.emit"...
  args: unknown[];
}

export interface MockCtxOptions {
  installationId?: string;
  supplierId?: number;
  connectorId?: string;
  config?: JsonObject;
  kv?: Record<string, JsonValue>;
  httpFixtures?: HttpFixture[];
  payLinks?: PayLinkDto[];
  invoices?: InvoiceDto[];
  oauthAccessToken?: string | null;
}

export interface MockCtx {
  ctx: ConnectorCtx;
  calls: RecordedCall[];
  /** État interne inspectable après le test. */
  state: {
    config: JsonObject;
    kv: Map<string, JsonValue>;
    invoices: InvoiceDto[];
    events: ConnectorEventInput[];
    savedPdfs: Array<{ invoiceId: string; payLinkId: string; filename: string; size: number }>;
    createdPayLinks: CreatePayLinkDto[];
    webhooks: ManagedWebhook[];
    sentQuoteEmails: string[];
  };
}

function matchFixture(
  fixtures: HttpFixture[],
  req: ConnectorHttpRequest
): HttpFixture | undefined {
  return fixtures.find((f) => {
    if (f.method && f.method.toUpperCase() !== (req.method ?? "GET").toUpperCase()) return false;
    return typeof f.url === "string" ? req.url.includes(f.url) : f.url.test(req.url);
  });
}

export function createMockCtx(options: MockCtxOptions = {}): MockCtx {
  const calls: RecordedCall[] = [];
  const record = (surface: string, ...args: unknown[]) => {
    calls.push({ surface, args });
  };

  const state: MockCtx["state"] = {
    config: { ...(options.config ?? {}) },
    kv: new Map(Object.entries(options.kv ?? {})),
    invoices: [...(options.invoices ?? [])],
    events: [],
    savedPdfs: [],
    createdPayLinks: [],
    webhooks: [],
    sentQuoteEmails: [],
  };

  const payLinks = options.payLinks ?? [samplePayLink()];
  const supplierId = options.supplierId ?? 4242;
  let invoiceCounter = 0;
  let payLinkCounter = 0;
  let webhookCounter = 0;
  const MAX_WEBHOOKS_PER_INSTALLATION = 5;

  const ctx: ConnectorCtx = {
    installation: {
      id: options.installationId ?? "cinst_testkit000000000000000000000000",
      connectorId: options.connectorId ?? "testkit",
      supplierId,
      name: "testkit",
      routesBaseUrl: `https://chorus-pay.test/api/connectors/${
        options.installationId ?? "cinst_testkit000000000000000000000000"
      }`,
    },

    config: {
      async get() {
        record("config.get");
        return { ...state.config };
      },
      async update(patch) {
        record("config.update", patch);
        state.config = { ...state.config, ...patch };
      },
    },

    http: {
      async fetch<T = unknown>(req: ConnectorHttpRequest): Promise<ConnectorHttpResponse<T>> {
        record("http.fetch", { url: req.url, method: req.method ?? "GET" });
        const fixture = matchFixture(options.httpFixtures ?? [], req);
        if (!fixture) {
          throw new ConnectorHttpError(
            `[testkit] aucune fixture HTTP pour ${req.method ?? "GET"} ${req.url}`,
            { url: req.url }
          );
        }
        if (fixture.error) {
          throw new ConnectorHttpError(
            fixture.error.message ?? `[testkit] HTTP ${fixture.error.status ?? 500}`,
            { status: fixture.error.status, url: req.url }
          );
        }
        return {
          status: fixture.status ?? 200,
          ok: true,
          data: fixture.data as T,
          headers: fixture.headers ?? {},
          durationMs: 1,
        };
      },
    },

    logger: {
      debug: (...args) => record("logger.debug", ...args),
      info: (...args) => record("logger.info", ...args),
      warn: (...args) => record("logger.warn", ...args),
      error: (...args) => record("logger.error", ...args),
    },

    events: {
      async emit(event) {
        record("events.emit", event);
        state.events.push(event);
      },
    },

    oauth: {
      async getAccessToken() {
        record("oauth.getAccessToken");
        return options.oauthAccessToken ?? null;
      },
      async isConnected() {
        return Boolean(options.oauthAccessToken);
      },
      async getAuthorizeUrl() {
        return null;
      },
    },

    payLinks: {
      async get(payLinkId) {
        record("payLinks.get", payLinkId);
        return payLinks.find((p) => p.id === payLinkId) ?? null;
      },
      async create(input) {
        record("payLinks.create", input);
        state.createdPayLinks.push(input);
        payLinkCounter++;
        return {
          id: `pl_testkit${String(payLinkCounter).padStart(4, "0")}`,
          quote_number: `TEST-${payLinkCounter}`,
          amount: "100.00",
          url: `https://example.test/link/pl_testkit${payLinkCounter}`,
          expires_at: null,
        };
      },
      async findActiveByMetadata(source, key, value) {
        record("payLinks.findActiveByMetadata", source, key, value);
        const found = payLinks.find(
          (p) => p.source === source && p.metadata?.[key] === value
        );
        return found
          ? {
              id: found.id,
              quote_number: found.quote_number,
              amount: found.amount,
              expires_at: found.expires_at,
            }
          : null;
      },
      async sendQuoteEmail(payLinkId) {
        record("payLinks.sendQuoteEmail", payLinkId);
        state.sentQuoteEmails.push(payLinkId);
        return { success: true };
      },
    },

    invoices: {
      async findLatestByPayLink(payLinkId, opts) {
        record("invoices.findLatestByPayLink", payLinkId, opts);
        const matches = state.invoices.filter(
          (i) =>
            i.pay_link_id === payLinkId && (!opts?.withErpId || i.erp_invoice_id !== null)
        );
        return matches[matches.length - 1] ?? null;
      },
      async create(input) {
        record("invoices.create", input);
        invoiceCounter++;
        const invoiceId = `inv_testkit${String(invoiceCounter).padStart(4, "0")}`;
        state.invoices.push({
          id: invoiceId,
          pay_link_id: input.payLinkId,
          status: "draft",
          amount: String(input.amount),
          currency: input.currency,
          erp_invoice_id: input.erpInvoiceId ?? null,
          erp_reference: input.erpReference ?? null,
          chorus_reference: null,
          invoice_pdf_file_id: null,
          created_at: "2026-01-01T00:00:00.000Z",
        });
        return { invoiceId };
      },
    },

    suppliers: {
      async getProfile() {
        record("suppliers.getProfile");
        return sampleSupplierProfile(supplierId);
      },
    },

    files: {
      async saveInvoicePdf(input) {
        record("files.saveInvoicePdf", {
          invoiceId: input.invoiceId,
          filename: input.filename,
          size: input.pdf.length,
        });
        state.savedPdfs.push({
          invoiceId: input.invoiceId,
          payLinkId: input.payLinkId,
          filename: input.filename,
          size: input.pdf.length,
        });
        const invoice = state.invoices.find((i) => i.id === input.invoiceId);
        const fileId = `file_testkit${state.savedPdfs.length}`;
        if (invoice) invoice.invoice_pdf_file_id = fileId;
        return fileId;
      },
      async download(fileId) {
        record("files.download", fileId);
        return Buffer.from(`%PDF-1.4 testkit ${fileId}`);
      },
    },

    kv: {
      async get(key) {
        record("kv.get", key);
        return state.kv.get(key) ?? null;
      },
      async set(key, value) {
        record("kv.set", key, value);
        state.kv.set(key, value);
      },
      async delete(key) {
        record("kv.delete", key);
        state.kv.delete(key);
      },
    },

    webhooks: {
      async create(input) {
        record("webhooks.create", input);
        if (state.webhooks.length >= MAX_WEBHOOKS_PER_INSTALLATION) {
          throw new Error(
            `[testkit] plafond de ${MAX_WEBHOOKS_PER_INSTALLATION} webhooks par installation atteint`
          );
        }
        if (!/^https:\/\//.test(input.url)) {
          throw new Error("[testkit] webhook url must be https://");
        }
        webhookCounter++;
        const webhook: ManagedWebhook = {
          id: `wh_testkit${String(webhookCounter).padStart(4, "0")}`,
          url: input.url,
          description: input.description ?? null,
          events: { ...input.events },
          enabled: true,
          secret: `whsec_testkit${String(webhookCounter).padStart(4, "0")}`,
          createdAt: "2026-01-01T00:00:00.000Z",
        };
        state.webhooks.push(webhook);
        return { ...webhook, events: { ...webhook.events } };
      },
      async list() {
        record("webhooks.list");
        return state.webhooks.map((w) => ({ ...w, events: { ...w.events } }));
      },
      async update(id, patch) {
        record("webhooks.update", id, patch);
        const webhook = state.webhooks.find((w) => w.id === id);
        if (!webhook) throw new Error(`[testkit] webhook inconnu: ${id}`);
        if (patch.url !== undefined) {
          if (!/^https:\/\//.test(patch.url)) {
            throw new Error("[testkit] webhook url must be https://");
          }
          webhook.url = patch.url;
        }
        if (patch.events !== undefined) webhook.events = { ...patch.events };
        if (patch.enabled !== undefined) webhook.enabled = patch.enabled;
        if (patch.description !== undefined) webhook.description = patch.description;
        return { ...webhook, events: { ...webhook.events } };
      },
      async delete(id) {
        record("webhooks.delete", id);
        state.webhooks = state.webhooks.filter((w) => w.id !== id);
      },
    },
  };

  return { ctx, calls, state };
}
