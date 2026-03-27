const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log("[SUPABASE] Cliente inicializado");
} else {
  console.warn("[SUPABASE] SUPABASE_URL ou SUPABASE_KEY não configurados — dispatches não serão persistidos");
}

/**
 * Salva ou atualiza um dispatch no Supabase (upsert por phone_short + identifier)
 */
async function upsertDispatch(dispatch, phoneShort, phoneFull) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from("dispatches").upsert(
      {
        identifier: dispatch.identifier,
        phone_short: phoneShort,
        phone_full: phoneFull,
        status: dispatch.status || "pending",
        contact_address: dispatch.contact_address || null,
        estimated_at: dispatch.estimated_at || null,
        arrived_at: dispatch.arrived_at || null,
        substatus: dispatch.substatus || null,
        items: dispatch.items || null,
        raw_data: dispatch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "phone_short,identifier" }
    );
    if (error) console.error("[SUPABASE] Upsert error:", error.message);
  } catch (err) {
    console.error("[SUPABASE] Upsert exception:", err.message);
  }
}

/**
 * Busca dispatches por telefone no Supabase
 */
async function fetchDispatches(phoneShort, phoneFull) {
  if (!supabase) return [];
  try {
    // Buscar por phone_short primeiro
    let { data, error } = await supabase
      .from("dispatches")
      .select("*")
      .eq("phone_short", phoneShort)
      .order("updated_at", { ascending: false })
      .limit(3);

    if (error) {
      console.error("[SUPABASE] Select error:", error.message);
      return [];
    }
    if (data && data.length > 0) return data;

    // Fallback: buscar por phone_full
    if (phoneFull && phoneFull !== phoneShort) {
      const result = await supabase
        .from("dispatches")
        .select("*")
        .eq("phone_full", phoneFull)
        .order("updated_at", { ascending: false })
        .limit(3);
      if (result.error) {
        console.error("[SUPABASE] Select (full) error:", result.error.message);
        return [];
      }
      return result.data || [];
    }

    return [];
  } catch (err) {
    console.error("[SUPABASE] Fetch exception:", err.message);
    return [];
  }
}

/**
 * Carrega todos os dispatches recentes pro cache (warm-up no startup)
 */
async function loadRecentDispatches() {
  if (!supabase) return [];
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("dispatches")
      .select("*")
      .gte("updated_at", thirtyDaysAgo)
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("[SUPABASE] Load error:", error.message);
      return [];
    }
    console.log(`[SUPABASE] ${(data || []).length} dispatches carregados do banco`);
    return data || [];
  } catch (err) {
    console.error("[SUPABASE] Load exception:", err.message);
    return [];
  }
}

module.exports = { supabase, upsertDispatch, fetchDispatches, loadRecentDispatches };
