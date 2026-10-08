import { createClient } from "@supabase/supabase-js";

import type { AppData } from "./types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null;

export async function joinRoom(slug: string, passwordHash: string) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { data, error } = await supabase.rpc("join_room", {
    p_slug: slug,
    p_password_hash: passwordHash,
  });

  if (error) throw error;
  return data as AppData;
}

export async function saveRoom(slug: string, passwordHash: string, roomData: AppData) {
  if (!supabase) throw new Error("Supabase is not configured yet.");

  const { error } = await supabase.rpc("save_room_data", {
    p_slug: slug,
    p_password_hash: passwordHash,
    p_data: roomData,
  });

  if (error) throw error;
}
