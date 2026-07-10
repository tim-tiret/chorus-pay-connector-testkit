import type { ConnectorDefinition, ErpInvoiceResult } from "@chorus-pay/connector-sdk";
import {
  buildConfigSchema,
  defineConnector,
  flattenFields,
  serializeManifest,
} from "@chorus-pay/connector-sdk";
import { createMockCtx } from "./mock-ctx.js";
import { samplePayLink } from "./fixtures.js";

/**
 * Types d'événements du catalogue Chorus Pay auxquels un hook peut s'accrocher
 * (mêmes événements que les webhooks). Tenu à jour avec lib/events/catalog.ts.
 * Les événements techniques (webhook.test, purchase_order) sont exclus.
 */
const KNOWN_EVENT_TYPES = new Set<string>([
  // pay_link
  "pay_link.created", "pay_link.sent", "pay_link.viewed", "pay_link.quote_email_sent",
  "pay_link.accepted", "pay_link.rejected", "pay_link.cancelled", "pay_link.recycled",
  "pay_link.expired", "pay_link.marked_as_paid", "pay_link.status_updated",
  "pay_link.scheduled_date_updated", "pay_link.purchase_order_uploaded",
  "pay_link.purchase_order_uploaded_by_client", "pay_link.purchase_order_analysed",
  // invoice
  "invoice.created", "invoice.deposited", "invoice.deposited_verified", "invoice.validated",
  "invoice.paid", "invoice.rejected", "invoice.action_required", "invoice.deposit_failed",
  "invoice.creation.failed", "invoice.chorus_status_updated",
  "invoice.created_in_pennylane", "invoice.pennylane_creation_failed",
  "invoice.created_in_dolibarr", "invoice.dolibarr_creation_failed",
  // identity
  "identity.verified",
]);

/**
 * Kit de conformité : vérifie qu'un connecteur respecte le protocole
 * (doc/connectors/CONNECTOR_SPEC.md) sans DB ni réseau. À exécuter en CI de
 * chaque repo de connecteur (scripts/connector/test.mjs pour les in-repo).
 */

export interface ConformanceIssue {
  level: "error" | "warning";
  check: string;
  message: string;
}

export interface ConformanceReport {
  connector: string;
  ok: boolean;
  issues: ConformanceIssue[];
}

/** Règle d'or Chorus : tout montant envoyé doit être arrondi au centime. */
export function assertCentRounded(amount: number, label = "amount"): void {
  const rounded = Math.round(amount * 100) / 100;
  if (Math.abs(amount - rounded) > Number.EPSILON) {
    throw new Error(
      `${label} n'est pas arrondi au centime : ${amount} (attendu ${rounded}) — ` +
        `Chorus affiche jusqu'à 4 décimales, le résidu apparaîtrait sur la facture`
    );
  }
}

function isSerializable(value: unknown, path = "$"): string | null {
  if (value === undefined || value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return null;
  if (Buffer.isBuffer(value)) return null;
  if (t === "function") return `${path} est une fonction`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = isSerializable(value[i], `${path}[${i}]`);
      if (err) return err;
    }
    return null;
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return `${path} est une instance de classe (${proto?.constructor?.name ?? "?"})`;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const err = isSerializable(v, `${path}.${k}`);
      if (err) return err;
    }
    return null;
  }
  return `${path} a un type non sérialisable (${t})`;
}

export async function runConformance(def: ConnectorDefinition): Promise<ConformanceReport> {
  const issues: ConformanceIssue[] = [];
  const error = (check: string, message: string) => issues.push({ level: "error", check, message });
  const warning = (check: string, message: string) =>
    issues.push({ level: "warning", check, message });

  // 1. Manifest valide (defineConnector re-valide tout : zod + invariants)
  try {
    defineConnector({ ...def });
  } catch (e) {
    error("manifest", e instanceof Error ? e.message : String(e));
  }

  // 2. Manifest sérialisable (zip/DB)
  try {
    const serialized = serializeManifest(def);
    JSON.parse(JSON.stringify(serialized));
  } catch (e) {
    error("manifest.serializable", e instanceof Error ? e.message : String(e));
  }

  // 3. Schéma de config constructible + champs cohérents
  try {
    buildConfigSchema(def.manifest.configFields);
    const fields = flattenFields(def.manifest.configFields);
    if (fields.length === 0 && def.manifest.category === "erp") {
      warning("configFields", "Aucun champ de config — inhabituel pour un connecteur ERP");
    }
  } catch (e) {
    error("configFields", e instanceof Error ? e.message : String(e));
  }

  // 4. checkConnection : contrat {success:false} (jamais de throw) sur config vide
  try {
    const { ctx } = createMockCtx({ config: {} });
    const result = await def.checkConnection(ctx);
    if (typeof result?.success !== "boolean") {
      error("checkConnection", "doit retourner { success: boolean, error?, data? }");
    } else if (result.success) {
      warning(
        "checkConnection",
        "retourne success=true avec une config vide — la validation de config semble absente"
      );
    }
    const serErr = isSerializable(result);
    if (serErr) error("checkConnection.serializable", serErr);
  } catch (e) {
    error(
      "checkConnection",
      `a jeté au lieu de retourner {success:false} : ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // 5. Capacité ERP : create sur config vide → échec au contrat ErpInvoiceResult
  if (def.manifest.category === "erp") {
    const create = def.capabilities?.invoice?.create;
    if (!create) {
      error("erp.create", "category erp sans capabilities.invoice.create");
    } else {
      try {
        const payLink = samplePayLink();
        const { ctx } = createMockCtx({ config: {}, payLinks: [payLink] });
        const result: ErpInvoiceResult = await create(ctx, {
          payLink,
          payLinkId: payLink.id,
          invoiceDate: "2026-01-02",
        });
        for (const key of ["invoiceId", "invoiceNumber", "invoiceResult", "invoicePdfFile", "error"]) {
          if (!(key in result)) {
            error("erp.create.shape", `champ manquant dans ErpInvoiceResult : ${key}`);
          }
        }
        if (!result.error && !result.invoiceId) {
          error(
            "erp.create.contract",
            "config vide : attendu un échec (`error` renseigné) ou un invoiceId — ni l'un ni l'autre"
          );
        }
        const serErr = isSerializable({ ...result, invoicePdfFile: null, invoiceResult: null });
        if (serErr) error("erp.create.serializable", serErr);
      } catch (e) {
        error(
          "erp.create",
          `a jeté sur config vide au lieu de retourner un ErpInvoiceResult d'échec : ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  // 6. Catégorie shop : gates présents et no-op rapides hors périmètre
  if (def.manifest.category === "shop") {
    const shop = def.capabilities?.shop;
    if (!shop || (!shop.onQuoteConfirmed && !shop.completeOrder && !shop.preDeposit)) {
      warning("shop", "aucun gate shop déclaré (onQuoteConfirmed/completeOrder/preDeposit)");
    }
    for (const gateName of ["onQuoteConfirmed", "completeOrder", "preDeposit"] as const) {
      const gate = shop?.[gateName];
      if (!gate) continue;
      try {
        const { ctx, calls } = createMockCtx({ config: {}, kv: {} });
        const result = await gate(ctx, { payLinkId: "pl_unknown", invoiceId: null } as never);
        if (result?.success !== true) {
          error(
            `shop.${gateName}`,
            "doit no-op en succès quand le pay link ne concerne pas la boutique (kv vide)"
          );
        }
        if (calls.some((c: { surface: string }) => c.surface === "http.fetch")) {
          warning(
            `shop.${gateName}`,
            "appel HTTP effectué pour un pay link hors périmètre — le no-op doit être rapide"
          );
        }
      } catch (e) {
        error(
          `shop.${gateName}`,
          `a jeté sur un pay link hors périmètre : ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  // 7. Statelessness (heuristique multi-tenant) : deux invocations avec des
  // ctx de tenants différents ne doivent pas se contaminer via l'état module.
  try {
    const a = createMockCtx({ supplierId: 1, config: { probe: "tenant-a" } });
    const b = createMockCtx({ supplierId: 2, config: { probe: "tenant-b" } });
    await def.checkConnection(a.ctx).catch(() => undefined);
    await def.checkConnection(b.ctx).catch(() => undefined);
    // Re-vérifier que le ctx A n'a pas été muté par l'appel B
    const configA = await a.ctx.config.get();
    if (configA.probe !== "tenant-a") {
      error("statelessness", "la config du tenant A a été altérée par l'invocation du tenant B");
    }
  } catch (e) {
    warning("statelessness", e instanceof Error ? e.message : String(e));
  }

  // 8. Routes : clés bien formées (déjà validé par defineConnector, on vérifie
  // la présence des handlers d'actions)
  for (const el of def.manifest.configFields) {
    if (el.type === "action" && !def.actions?.[el.key]) {
      error("actions", `bouton d'action "${el.key}" sans handler`);
    }
  }

  // 9. Hooks : les clés doivent correspondre à un type d'événement du
  // catalogue Chorus Pay. Une clé inconnue (faute de frappe) ne se
  // déclencherait jamais en silence — on la signale.
  for (const key of Object.keys(def.hooks ?? {})) {
    if (!KNOWN_EVENT_TYPES.has(key)) {
      warning(
        "hooks",
        `hook "${key}" ne correspond à aucun type d'événement connu — il ne se déclenchera jamais (voir la liste dans la doc)`,
      );
    }
  }

  // 10. OAuth entrant : cohérence manifest ↔ lifecycle
  const inbound = def.manifest.inboundOauth;
  if (inbound) {
    if (!def.lifecycle?.onOauthConnected) {
      warning(
        "inboundOauth",
        "inboundOauth déclaré sans lifecycle.onOauthConnected — rien ne sera provisionné à la connexion"
      );
    }
    if (inbound.redirectUris.includes("*")) {
      warning(
        "inboundOauth",
        'redirectUris ["*"] accepte tout domaine — justifié seulement pour les apps auto-hébergées'
      );
    }
  } else if (
    def.lifecycle &&
    (def.lifecycle.onOauthConnected || def.lifecycle.onOauthRevoked)
  ) {
    // Les hooks d'installation (onInstall/onEnable/onDisable/onUninstall/
    // onConfigSaved) sont invoqués par le core sans inboundOauth ; seuls les
    // hooks OAuth entrants n'ont pas de sens sans manifest.inboundOauth.
    warning(
      "lifecycle",
      "hooks OAuth (onOauthConnected/onOauthRevoked) déclarés sans manifest.inboundOauth — ils ne seront jamais invoqués"
    );
  }

  // 11. onOauthConnected : idempotence (invoqué à CHAQUE connexion/reconnexion
  // OAuth — deux appels doivent converger : même webhook, même secret) et
  // contrat de retour (tokenResponseExtras = valeurs string plates).
  if (def.lifecycle?.onOauthConnected) {
    try {
      const { ctx, state } = createMockCtx({ config: {} });
      const event = {
        shopUrl: "https://boutique.example.test",
        scopes: inbound?.scopes ?? ["pay_links", "webhooks"],
        clientId: inbound?.clientId ?? "testkit_client",
      };
      const first = await def.lifecycle.onOauthConnected(ctx, event);
      const webhooksAfterFirst = state.webhooks.length;
      const second = await def.lifecycle.onOauthConnected(ctx, event);
      if (state.webhooks.length !== webhooksAfterFirst) {
        error(
          "lifecycle.onOauthConnected",
          `non idempotent : ${webhooksAfterFirst} webhook(s) après le 1er appel, ` +
            `${state.webhooks.length} après le 2e (une reconnexion ne doit pas dupliquer)`
        );
      }
      for (const result of [first, second]) {
        if (!result) continue;
        const serErr = isSerializable(result);
        if (serErr) error("lifecycle.onOauthConnected.serializable", serErr);
        for (const [key, value] of Object.entries(result.tokenResponseExtras ?? {})) {
          if (typeof value !== "string") {
            error(
              "lifecycle.onOauthConnected",
              `tokenResponseExtras.${key} doit être une string (valeurs plates uniquement)`
            );
          }
        }
      }
      const firstSecret = first?.tokenResponseExtras?.webhook_secret;
      const secondSecret = second?.tokenResponseExtras?.webhook_secret;
      if (firstSecret && secondSecret && firstSecret !== secondSecret) {
        error(
          "lifecycle.onOauthConnected",
          "webhook_secret différent entre deux connexions — la reconnexion doit renvoyer le secret existant"
        );
      }
    } catch (e) {
      error(
        "lifecycle.onOauthConnected",
        `a jeté : ${e instanceof Error ? e.message : String(e)} — un échec ne doit ` +
          "jamais casser la délivrance du token, retourner proprement"
      );
    }
  }

  return {
    connector: def.manifest.id,
    ok: issues.every((i) => i.level !== "error"),
    issues,
  };
}
